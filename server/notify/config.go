// Package notify delivers workflow notifications (docs/notifications.md).
// The opt-in lives on the Job (the submitted template) as annotations under
// notifications.argoproj.io/ and is copied onto the workflow by the server
// submit path; a namespace-default ConfigMap
// (argo-notifications) defines the destinations (transports and their
// credentials) and fills in the gaps for workflows without annotations.
package notify

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	v1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

// ConfigMapName is the notification ConfigMap every namespace may carry. Its
// data keys are destination definitions (name -> transport JSON), plus the
// reserved keys defaults (namespace defaults) and runner-health (install
// namespace only: runner-health destinations and thresholds).
const ConfigMapName = "argo-notifications"

// Reserved ConfigMap keys (never destination names).
const (
	keyDefaults     = "defaults"
	keyRunnerHealth = "runner-health"
)

// LabelSecretAllowed marks a Secret a notification destination may read its
// credentials from, in the ConfigMap's own namespace (the same shape as the
// runner secret rules: labelling is the operator's explicit act).
const LabelSecretAllowed = "notifications.argoproj.io/allowed"

// Triggers a workflow may opt into. Phase triggers fire once per phase
// transition; suspended and waiting fire per node and workflow; the periodic
// ones (duration-exceeded) are evaluated by the controller's ticker.
const (
	TriggerStarted          = "started"
	TriggerSucceeded        = "succeeded"
	TriggerFailed           = "failed"
	TriggerError            = "error" // retryable failure (the UI offers retry)
	TriggerSuspended        = "suspended"
	TriggerWaiting          = "waiting"
	TriggerDurationExceeded = "duration-exceeded"
)

// validTriggers is the closed set of trigger names.
var validTriggers = map[string]struct{}{
	TriggerStarted: {}, TriggerSucceeded: {}, TriggerFailed: {}, TriggerError: {},
	TriggerSuspended: {}, TriggerWaiting: {}, TriggerDurationExceeded: {},
}

// annotationName returns the full annotation key for a notifications key.
func annotationName(key string) string {
	return common.AnnotationPrefixNotifications + key
}

// WorkflowOptIn is the notification opt-in for one workflow, resolved from
// the workflow's annotations with the namespace defaults filling the gaps.
type WorkflowOptIn struct {
	// Destinations are the destination names every enabled trigger delivers
	// to.
	Destinations []string
	// OnTrigger overrides the destinations for one trigger.
	OnTrigger map[string][]string
	// Triggers is the closed set of enabled triggers.
	Triggers map[string]struct{}
	// MaxDuration is the duration-exceeded threshold (0 disables).
	MaxDuration time.Duration
	// SuppressSuccess suppresses success notifications for this Job.
	SuppressSuccess bool
}

// ResolvedWorkflow is the fully resolved configuration for one workflow:
// the opt-in plus the destination definitions it names.
type ResolvedWorkflow struct {
	OptIn        WorkflowOptIn
	Destinations map[string]Transport
}

// enabled reports whether a trigger is opted in.
func (o *WorkflowOptIn) enabled(trigger string) bool {
	_, ok := o.Triggers[trigger]
	return ok
}

// destinationsFor returns the destinations a trigger delivers to (the
// per-trigger override, else the general list).
func (o *WorkflowOptIn) destinationsFor(trigger string) []string {
	if override, ok := o.OnTrigger[trigger]; ok {
		return override
	}
	return o.Destinations
}

// ParseTriggers parses a comma-separated trigger list (closed set).
func ParseTriggers(raw string) ([]string, error) {
	var triggers []string
	for entry := range strings.SplitSeq(raw, ",") {
		if entry = strings.TrimSpace(entry); entry == "" {
			continue
		}
		if _, ok := validTriggers[entry]; !ok {
			return nil, fmt.Errorf("unknown trigger %q", entry)
		}
		triggers = append(triggers, entry)
	}
	return triggers, nil
}

// resolveOptIn resolves a workflow's notification opt-in: the workflow's own
// annotations first, the namespace defaults for anything it leaves out. A
// workflow with neither opts out entirely (nil).
func resolveOptIn(wf *wfv1.Workflow, defaults *NamespaceDefaults) *WorkflowOptIn {
	annotations := wf.Annotations
	_, hasDestinations := annotations[annotationName("destinations")]
	_, hasTriggers := annotations[annotationName("triggers")]
	optIn := &WorkflowOptIn{OnTrigger: map[string][]string{}}
	if defaults != nil {
		optIn.Destinations = defaults.Destinations
		optIn.Triggers = defaults.Triggers
		optIn.MaxDuration = defaults.MaxDuration
	}
	if hasDestinations {
		optIn.Destinations = splitList(annotations[annotationName("destinations")])
	}
	if hasTriggers {
		triggers, _ := ParseTriggers(annotations[annotationName("triggers")])
		optIn.Triggers = make(map[string]struct{}, len(triggers))
		for _, trigger := range triggers {
			optIn.Triggers[trigger] = struct{}{}
		}
	}
	// Per-trigger destination overrides: notifications.argoproj.io/on-<trigger>.
	for trigger := range validTriggers {
		if raw, ok := annotations[annotationName("on-"+trigger)]; ok {
			optIn.OnTrigger[trigger] = splitList(raw)
		}
	}
	if raw := annotations[annotationName("max-duration")]; raw != "" {
		if duration, err := time.ParseDuration(raw); err == nil {
			optIn.MaxDuration = duration
		}
	}
	if strings.EqualFold(strings.TrimSpace(annotations[annotationName("suppress-success")]), "true") {
		optIn.SuppressSuccess = true
	}
	// No triggers or no destinations anywhere: opted out.
	if len(optIn.Triggers) == 0 || len(optIn.Destinations) == 0 && len(optIn.OnTrigger) == 0 {
		return nil
	}
	return optIn
}

// NamespaceDefaults are the namespace-level notification defaults from the
// argo-notifications ConfigMap's "defaults" key.
type NamespaceDefaults struct {
	Destinations []string
	Triggers     map[string]struct{}
	MaxDuration  time.Duration
}

// ConfigSource loads notification configuration from the namespace
// ConfigMaps, cached briefly: workflow updates arrive in bursts (an informer
// resync re-evaluates every workflow), so each event must not cost a
// ConfigMap read.
type ConfigSource struct {
	kube   kubernetes.Interface
	now    func() time.Time
	mu     sync.Mutex
	cached map[string]cachedConfigMap
}

// configCacheTTL is how long a namespace's notification ConfigMap is
// cached. Rotation of destinations takes effect within this window.
const configCacheTTL = 30 * time.Second

type cachedConfigMap struct {
	cm      *v1.ConfigMap
	expires time.Time
}

func NewConfigSource(kube kubernetes.Interface) *ConfigSource {
	return &ConfigSource{kube: kube, now: time.Now, cached: map[string]cachedConfigMap{}}
}

// loadConfigMap loads the argo-notifications ConfigMap of a namespace (nil
// when the namespace carries none).
func (c *ConfigSource) loadConfigMap(ctx context.Context, namespace string) (*v1.ConfigMap, error) {
	if entry, ok := c.cachedGet(namespace); ok {
		return entry, nil
	}
	cm, err := c.kube.CoreV1().ConfigMaps(namespace).Get(ctx, ConfigMapName, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			c.cachedPut(namespace, nil)
			return nil, nil
		}
		return nil, fmt.Errorf("loading %s in namespace %s: %w", ConfigMapName, namespace, err)
	}
	c.cachedPut(namespace, cm)
	return cm, nil
}

func (c *ConfigSource) cachedGet(namespace string) (*v1.ConfigMap, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	entry, ok := c.cached[namespace]
	if !ok || c.now().After(entry.expires) {
		return nil, false
	}
	return entry.cm, true
}

func (c *ConfigSource) cachedPut(namespace string, cm *v1.ConfigMap) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if len(c.cached) >= 256 {
		// Bound the cache: drop expired entries first, then the oldest.
		now := c.now()
		for ns, entry := range c.cached {
			if now.After(entry.expires) {
				delete(c.cached, ns)
			}
		}
		if len(c.cached) >= 256 {
			return
		}
	}
	c.cached[namespace] = cachedConfigMap{cm: cm, expires: c.now().Add(configCacheTTL)}
}

// ResolveWorkflow resolves a workflow's notification configuration: the
// opt-in from its annotations and the namespace defaults, plus the
// destination definitions. A workflow that opted out returns nil.
func (c *ConfigSource) ResolveWorkflow(ctx context.Context, wf *wfv1.Workflow) (*ResolvedWorkflow, error) {
	if wf == nil {
		return nil, nil
	}
	cm, err := c.loadConfigMap(ctx, wf.Namespace)
	if err != nil {
		return nil, err
	}
	var defaults *NamespaceDefaults
	destinations := map[string]Transport{}
	if cm != nil {
		for key, raw := range cm.Data {
			switch key {
			case keyDefaults:
				defaults = parseDefaults(raw)
			case keyRunnerHealth:
				continue // install-namespace only, parsed separately
			default:
				var transport Transport
				dec := json.NewDecoder(strings.NewReader(raw))
				dec.DisallowUnknownFields()
				if err := dec.Decode(&transport); err != nil {
					continue // a malformed destination never blocks the others
				}
				destinations[key] = transport
			}
		}
	}
	optIn := resolveOptIn(wf, defaults)
	if optIn == nil {
		return nil, nil
	}
	// Keep only the destinations the opt-in actually names; an annotation
	// naming a destination the ConfigMap does not define delivers nothing
	// for it (logged as an error delivery at send time).
	resolved := &ResolvedWorkflow{OptIn: *optIn, Destinations: map[string]Transport{}}
	for _, name := range optIn.Destinations {
		if transport, ok := destinations[name]; ok {
			resolved.Destinations[name] = transport
		}
	}
	for _, list := range optIn.OnTrigger {
		for _, name := range list {
			if transport, ok := destinations[name]; ok {
				resolved.Destinations[name] = transport
			}
		}
	}
	return resolved, nil
}

// RunnerHealthConfig is the runner-health pipeline configuration from the
// install namespace's ConfigMap: destinations for the health events, and
// the offline and queue-depth thresholds that raise them.
type RunnerHealthConfig struct {
	Destinations    []string
	OfflineMinutes  int // a runner with no heartbeat for this long is offline
	QueueDepthAlert int // a pool whose queue is deeper than this is backlogged
}

// ResolveRunnerHealth resolves the runner-health configuration from the
// install namespace. A nil result (no ConfigMap or no runner-health key)
// disables runner-health notifications entirely.
func (c *ConfigSource) ResolveRunnerHealth(ctx context.Context, installNamespace string) (*RunnerHealthConfig, map[string]Transport, error) {
	cm, err := c.loadConfigMap(ctx, installNamespace)
	if err != nil || cm == nil {
		return nil, nil, err
	}
	raw, ok := cm.Data[keyRunnerHealth]
	if !ok {
		return nil, nil, nil
	}
	health := struct {
		Destinations    []string `json:"destinations"`
		OfflineMinutes  int      `json:"offlineMinutes"`
		QueueDepthAlert int      `json:"queueDepthAlert"`
	}{}
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&health); err != nil {
		return nil, nil, fmt.Errorf("invalid runner-health configuration: %w", err)
	}
	// The destinations resolve against the same ConfigMap's destination
	// definitions (install namespace).
	destinations := map[string]Transport{}
	for key, raw := range cm.Data {
		if key == keyDefaults || key == keyRunnerHealth {
			continue
		}
		var transport Transport
		dec := json.NewDecoder(strings.NewReader(raw))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&transport); err != nil {
			continue
		}
		destinations[key] = transport
	}
	return &RunnerHealthConfig{
		Destinations:    health.Destinations,
		OfflineMinutes:  health.OfflineMinutes,
		QueueDepthAlert: health.QueueDepthAlert,
	}, destinations, nil
}

// parseDefaults parses the reserved "defaults" key.
func parseDefaults(raw string) *NamespaceDefaults {
	type defaultsJSON struct {
		Destinations []string `json:"destinations"`
		Triggers     []string `json:"triggers"`
		MaxDuration  string   `json:"maxDuration"`
	}
	var parsed defaultsJSON
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&parsed); err != nil {
		return nil
	}
	triggers := make(map[string]struct{}, len(parsed.Triggers))
	for _, trigger := range parsed.Triggers {
		if _, ok := validTriggers[trigger]; ok {
			triggers[trigger] = struct{}{}
		}
	}
	var maxDuration time.Duration
	if parsed.MaxDuration != "" {
		if duration, err := time.ParseDuration(parsed.MaxDuration); err == nil {
			maxDuration = duration
		}
	}
	return &NamespaceDefaults{Destinations: parsed.Destinations, Triggers: triggers, MaxDuration: maxDuration}
}

// splitList splits a comma-separated annotation value.
func splitList(raw string) []string {
	var items []string
	for entry := range strings.SplitSeq(raw, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			items = append(items, entry)
		}
	}
	return items
}

// secretValue resolves a Value that may be inline or a Secret reference. A
// referenced Secret must live in namespace and carry the allowed label; a
// missing, unlabelled or unreadable Secret is an error the delivery records
// (the destination is operator configuration, so the failure is visible
// rather than silently dropped).
func secretValue(ctx context.Context, kube kubernetes.Interface, namespace string, value Value, what string) (string, error) {
	if value.Value != "" {
		return value.Value, nil
	}
	if value.Secret == nil {
		return "", fmt.Errorf("%s is not configured", what)
	}
	secret, err := kube.CoreV1().Secrets(namespace).Get(ctx, value.Secret.Name, metav1.GetOptions{})
	if err != nil {
		if apierrors.IsNotFound(err) {
			return "", fmt.Errorf("%s secret %q was not found", what, value.Secret.Name)
		}
		return "", fmt.Errorf("%s secret %q could not be read: %w", what, value.Secret.Name, err)
	}
	if secret.Labels[LabelSecretAllowed] != api.SecretAllowedValue {
		return "", fmt.Errorf("%s secret %q is not labelled %s=%s", what, value.Secret.Name, LabelSecretAllowed, api.SecretAllowedValue)
	}
	data, ok := secret.Data[value.Secret.Key]
	if !ok {
		return "", fmt.Errorf("%s secret %q has no key %q", what, value.Secret.Name, value.Secret.Key)
	}
	if len(data) > api.MaxEnvValueBytes {
		return "", fmt.Errorf("%s secret %q exceeds %d bytes", what, value.Secret.Name, api.MaxEnvValueBytes)
	}
	return string(data), nil
}
