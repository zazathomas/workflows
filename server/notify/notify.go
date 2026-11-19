package notify

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	apiv1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	informers "github.com/argoproj/argo-workflows/v4/pkg/client/informers/externalversions"
	wfsv1alpha1 "github.com/argoproj/argo-workflows/v4/pkg/client/informers/externalversions/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/server/fleetmetrics"
	informerutil "github.com/argoproj/argo-workflows/v4/util/informer"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

const (
	// requestTimeout is the per-delivery timeout (parameter-source rule).
	requestTimeout = 10 * time.Second
	// resync is the informer resync period: it bounds how long a missed
	// update can delay a notification.
	resync = time.Minute
	// tick is how often the periodic triggers are evaluated
	// (duration-exceeded, runner offline, backlog).
	tick = 30 * time.Second
	// dedupeLimit bounds the dedupe table; entries older than dedupeTTL are
	// purged first.
	dedupeLimit = 4096
	dedupeTTL   = 24 * time.Hour
)

// RunnerStatus is one runner's health for the runner-health pipeline.
type RunnerStatus struct {
	ID         string
	Pool       string
	Status     string
	LastSeen   string
	EnrolledAt string
}

// RunnerFleet is the runner fleet state the controller's runner-health scan
// reads. The runner extension supplies it; when the extension is disabled
// the controller runs without runner health.
type RunnerFleet interface {
	// Runners lists the fleet's runner records.
	Runners(ctx context.Context) ([]RunnerStatus, error)
	// PoolDepths returns the pending task count by pool label.
	PoolDepths() map[string]int
}

// ControllerConfig configures a Controller.
type ControllerConfig struct {
	Kube        kubernetes.Interface
	WF          versioned.Interface
	Instruments *fleetmetrics.Instruments
	// AllowHosts is the parsed ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS policy;
	// empty means no host is allowed, so every webhook and SMTP delivery
	// fails closed (visible as an error delivery, never a silent skip).
	AllowHosts map[string]struct{}
	Durable    bool
	// InstallNamespace is the argo-server namespace: where the runner-health
	// configuration is read and the controller runs.
	InstallNamespace string
	// ManagedNamespace restricts the workflow informer to one namespace
	// (argo-server -n); empty watches every namespace.
	ManagedNamespace string
	Instance         instanceid.Service
	Hydrator         hydrator.Interface
	// Fleet is the runner fleet state (optional; nil disables runner
	// health).
	Fleet RunnerFleet
	Log   logging.Logger
	Now   func() time.Time
	// HTTPClient overrides the delivery HTTP client (tests use a
	// TLS-trusting client against a self-signed test server; production
	// leaves it nil for the strict default).
	HTTPClient *http.Client
}

// Controller watches Workflows and delivers the notifications the workflow
// (or its Job) opted into (docs/notifications.md). It also evaluates the
// periodic triggers (duration exceeded, runner offline, pool backlog) on a
// ticker.
type Controller struct {
	kube             kubernetes.Interface
	wf               versioned.Interface
	instruments      *fleetmetrics.Instruments
	allowHosts       map[string]struct{}
	httpClient       *http.Client
	durable          bool
	installNamespace string
	managedNamespace string
	instance         instanceid.Service
	hydrator         hydrator.Interface
	fleet            RunnerFleet
	log              logging.Logger
	now              func() time.Time
	// configs resolves notification configuration, cached briefly.
	configs *ConfigSource

	dedupeMu sync.Mutex
	dedupe   map[string]time.Time

	// fleetAlerted deduplicates periodic runner-health alerts per pool or
	// runner (re-alert only after the condition clears, which the ticker
	// tracks by remembering what is currently bad).
	fleetMu     sync.Mutex
	offlineSeen map[string]bool // runner ID -> currently reported offline
	backlogSeen map[string]bool // pool -> currently reported backlogged
}

// WithFleet wires the runner fleet state (optional: nil disables runner
// health while the rest of the pipeline keeps working).
func (c *Controller) WithFleet(fleet RunnerFleet) *Controller {
	c.fleet = fleet
	return c
}

// NewController creates a Controller.
func NewController(cfg ControllerConfig) *Controller {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Controller{
		kube:             cfg.Kube,
		wf:               cfg.WF,
		instruments:      cfg.Instruments,
		allowHosts:       cfg.AllowHosts,
		httpClient:       cfg.HTTPClient,
		durable:          cfg.Durable,
		installNamespace: cfg.InstallNamespace,
		managedNamespace: cfg.ManagedNamespace,
		instance:         cfg.Instance,
		hydrator:         cfg.Hydrator,
		fleet:            cfg.Fleet,
		log:              cfg.Log,
		now:              now,
		configs:          NewConfigSource(cfg.Kube),
		dedupe:           map[string]time.Time{},
		offlineSeen:      map[string]bool{},
		backlogSeen:      map[string]bool{},
	}
}

// Run starts the workflow informer and the periodic trigger loop, and blocks
// until the informer cache has synced, then returns (the loops run in
// goroutines until ctx is done).
func (c *Controller) Run(ctx context.Context) error {
	if len(c.allowHosts) == 0 {
		return nil
	}
	factory := informers.NewSharedInformerFactoryWithOptions(c.wf, resync,
		informers.WithNamespace(c.managedNamespace), informers.WithTweakListOptions(func(options *metav1.ListOptions) {
			if c.instance != nil {
				c.instance.With(options)
			}
		}))
	informer := factory.Argoproj().V1alpha1().Workflows()
	if err := informer.Informer().SetTransform(informerutil.StripManagedFields); err != nil {
		return err
	}
	return c.RunWithInformer(ctx, informer, factory.Start)
}

// RunWithInformer shares a single watch across extension reconcilers.
func (c *Controller) RunWithInformer(ctx context.Context, informer wfsv1alpha1.WorkflowInformer, start func(<-chan struct{})) error {
	if len(c.allowHosts) == 0 {
		return nil
	}
	queue := workqueue.NewTypedDelayingQueue[[2]string]()
	enqueue := func(obj any) {
		if wf, ok := obj.(*wfv1.Workflow); ok && wf.Status.Phase != "" {
			queue.Add([2]string{wf.Namespace, wf.Name})
		}
	}
	_, err := informer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    enqueue,
		UpdateFunc: func(_, obj any) { enqueue(obj) },
	})
	if err != nil {
		return fmt.Errorf("registering workflow informer handler: %w", err)
	}
	start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), informer.Informer().HasSynced) {
		return fmt.Errorf("workflow informer cache did not sync")
	}
	go func() {
		<-ctx.Done()
		queue.ShutDown()
	}()
	for range 4 {
		go func() {
			for ctx.Err() == nil {
				key, shutdown := queue.Get()
				if shutdown {
					return
				}
				if wf, err := informer.Lister().Workflows(key[0]).Get(key[1]); err == nil {
					if due := c.evaluateWorkflow(ctx, wf); !due.IsZero() {
						queue.AddAfter(key, due.Sub(c.now()))
					}
				}
				queue.Done(key)
			}
		}()
	}
	if c.fleet != nil {
		go c.tickLoop(ctx)
	}
	if c.durable {
		go c.runOutbox(ctx)
	}
	return nil
}

// tickLoop evaluates the periodic triggers.
func (c *Controller) tickLoop(ctx context.Context) {
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.checkRunnerHealth(ctx)
		}
	}
}

// evaluateWorkflow resolves the notification opt-in and fires the triggers
// the workflow's current state implies.
func (c *Controller) evaluateWorkflow(ctx context.Context, wf *wfv1.Workflow) (next time.Time) {
	if wf == nil {
		return next
	}
	resolved, err := c.configs.ResolveWorkflow(ctx, wf)
	if err != nil {
		c.log.WithField("workflow", wf.Namespace+"/"+wf.Name).WithError(err).Warn(ctx, "failed to resolve notification configuration")
		return c.now().Add(tick)
	}
	if resolved == nil {
		return next
	}
	optIn := resolved.OptIn
	// Phase triggers: one notification per workflow UID and phase.
	phase := string(wf.Status.Phase)
	switch phase {
	case string(wfv1.WorkflowRunning):
		c.fire(ctx, wf, resolved, TriggerStarted, phase, "run started")
	case string(wfv1.WorkflowSucceeded):
		if optIn.SuppressSuccess {
			c.countDelivery(TriggerSucceeded, "", OutcomeSuppressed)
			return next
		}
		c.fire(ctx, wf, resolved, TriggerSucceeded, phase, "run succeeded")
	case string(wfv1.WorkflowFailed):
		c.fire(ctx, wf, resolved, TriggerFailed, phase, "run failed")
	case string(wfv1.WorkflowError):
		c.fire(ctx, wf, resolved, TriggerError, phase, "run errored (retryable)")
	}
	// Suspended nodes: one notification per workflow UID and node.
	if optIn.enabled(TriggerSuspended) {
		if c.hydrator != nil && !c.hydrator.IsHydrated(wf) {
			wf = wf.DeepCopy()
			if err := c.hydrator.Hydrate(ctx, wf); err != nil {
				c.log.WithError(err).Warn(ctx, "could not hydrate workflow for notifications")
				return c.now().Add(tick)
			}
		}
		for _, node := range wf.Status.Nodes {
			if node.Type == wfv1.NodeTypeSuspend && node.Phase == wfv1.NodeRunning {
				c.fire(ctx, wf, resolved, TriggerSuspended, node.ID, fmt.Sprintf("run is waiting on the suspended step %q", node.DisplayName))
			}
		}
	}
	// Waiting on synchronization: the workflow is Pending and its message
	// says it is waiting for a lock.
	if optIn.enabled(TriggerWaiting) && wf.Status.Phase == wfv1.WorkflowPending && strings.Contains(wf.Status.Message, "Waiting for") {
		c.fire(ctx, wf, resolved, TriggerWaiting, "sync", fmt.Sprintf("run is waiting: %s", wf.Status.Message))
	}
	if (wf.Status.Phase == wfv1.WorkflowRunning || wf.Status.Phase == wfv1.WorkflowPending) && !wf.Status.StartedAt.IsZero() &&
		optIn.MaxDuration > 0 && optIn.enabled(TriggerDurationExceeded) {
		due := wf.Status.StartedAt.Add(optIn.MaxDuration)
		if due.After(c.now()) {
			return due
		}
		c.fire(ctx, wf, resolved, TriggerDurationExceeded, "duration", fmt.Sprintf("run exceeded its max duration of %s", optIn.MaxDuration))
	}
	return next
}

// fire delivers one trigger for one workflow, deduplicated by workflow UID
// and trigger (plus a detail key for per-node triggers).
func (c *Controller) fire(ctx context.Context, wf *wfv1.Workflow, resolved *ResolvedWorkflow, trigger, detail, subject string) {
	optIn := resolved.OptIn
	if !optIn.enabled(trigger) {
		return
	}
	if !c.durable && !c.markSent(wf, trigger, detail) {
		return
	}
	names := optIn.destinationsFor(trigger)
	if len(names) == 0 {
		return
	}
	delivery := Delivery{
		Trigger:   trigger,
		Subject:   fmt.Sprintf("%s: %s", wf.Name, subject),
		Body:      fmt.Sprintf("Run %s in namespace %s.\n%s", wf.Name, wf.Namespace, nonEmpty(wf.Status.Message)),
		Workflow:  &WorkflowRef{Name: wf.Name, Namespace: wf.Namespace, Phase: string(wf.Status.Phase), UID: string(wf.UID)},
		DedupeKey: string(wf.UID) + "/" + trigger + "/" + detail,
	}
	if c.durable {
		// Do not put free-form workflow status, node names, or credential-bearing
		// transport configuration in the durable record.
		delivery.Subject = fmt.Sprintf("%s: %s", wf.Name, trigger)
		delivery.Body = fmt.Sprintf("Run %s in namespace %s.", wf.Name, wf.Namespace)
		for _, name := range names {
			transport, ok := resolved.Destinations[name]
			if !ok {
				continue
			}
			if _, err := c.enqueue(ctx, wf.Namespace, name, transport, delivery); err != nil {
				c.countDelivery(trigger, transport.Type, OutcomeError)
				c.log.WithError(err).Warn(ctx, "failed to queue notification intent")
			}
		}
		return
	}
	outcomes := c.Deliver(ctx, wf.Namespace, resolved.Destinations, names, delivery)
	c.auditDelivery(ctx, wf, trigger, names, outcomes)
}

// markSent deduplicates on workflow UID plus trigger plus detail (phase or
// node ID). It returns false when the notification was already sent.
func (c *Controller) markSent(wf *wfv1.Workflow, trigger, detail string) bool {
	key := string(wf.UID) + "/" + trigger + "/" + detail
	now := c.now()
	c.dedupeMu.Lock()
	defer c.dedupeMu.Unlock()
	if len(c.dedupe) >= dedupeLimit {
		for k, at := range c.dedupe {
			if now.Sub(at) > dedupeTTL {
				delete(c.dedupe, k)
			}
		}
		if len(c.dedupe) >= dedupeLimit {
			return false // fail closed: a notification storm must not grow unbounded
		}
	}
	if _, sent := c.dedupe[key]; sent {
		return false
	}
	c.dedupe[key] = now
	return true
}

// checkRunnerHealth reports offline runners and backlogged pools through the
// runner-health pipeline (install-namespace configuration). Each condition
// re-alerts only after it cleared (the *Seen maps track the current state).
func (c *Controller) checkRunnerHealth(ctx context.Context) {
	if c.fleet == nil {
		return
	}
	health, _, err := c.configs.ResolveRunnerHealth(ctx, c.installNamespace)
	if err != nil {
		c.log.WithError(err).Warn(ctx, "failed to resolve the runner-health notification configuration")
		return
	}
	if health == nil || len(health.Destinations) == 0 {
		return
	}
	now := c.now()
	// Offline runners.
	if health.OfflineMinutes > 0 {
		runners, err := c.fleet.Runners(ctx)
		if err != nil {
			c.log.WithError(err).Warn(ctx, "runner-health scan failed to list runners")
			return
		}
		c.fleetMu.Lock()
		offlineSeen := c.offlineSeen
		c.offlineSeen = map[string]bool{}
		stillOffline := map[string]bool{}
		c.fleetMu.Unlock()
		for _, runner := range runners {
			// The liveness time falls back to the enrolment time: a runner that
			// has never claimed (so never heartbeated) is offline only once it
			// has been enrolled for longer than the threshold.
			lastSeen, err := time.Parse(time.RFC3339, runner.LastSeen)
			if err != nil || runner.LastSeen == "" {
				if lastSeen, err = time.Parse(time.RFC3339, runner.EnrolledAt); err != nil {
					continue // unparsable metadata: not evidence of anything
				}
			}
			if now.Sub(lastSeen) <= time.Duration(health.OfflineMinutes)*time.Minute {
				continue
			}
			stillOffline[runner.ID] = true
			if offlineSeen[runner.ID] {
				continue // already reported
			}
			c.NotifyRunnerEvent(ctx, "runner-offline", fmt.Sprintf("runner %s (pool %s) has not been seen for over %d minutes", runner.ID, runner.Pool, health.OfflineMinutes))
		}
		c.fleetMu.Lock()
		c.offlineSeen = stillOffline
		c.fleetMu.Unlock()
	}
	// Backlogged pools.
	if health.QueueDepthAlert > 0 {
		depths := c.fleet.PoolDepths()
		c.fleetMu.Lock()
		backlogSeen := c.backlogSeen
		c.backlogSeen = map[string]bool{}
		stillBacklogged := map[string]bool{}
		c.fleetMu.Unlock()
		for pool, depth := range depths {
			if depth <= health.QueueDepthAlert {
				continue
			}
			stillBacklogged[pool] = true
			if backlogSeen[pool] {
				continue
			}
			c.NotifyRunnerEvent(ctx, "pool-backlog", fmt.Sprintf("runner pool %s has %d tasks queued (over the %d threshold)", pool, depth, health.QueueDepthAlert))
		}
		c.fleetMu.Lock()
		c.backlogSeen = stillBacklogged
		c.fleetMu.Unlock()
	}
}

// NotifyRunnerEvent delivers one runner-health event (offline, quarantined,
// revoked, backlog) through the runner-health pipeline (the install
// namespace's argo-notifications ConfigMap). It is the method the runner
// admin API calls on quarantine and revoke; the periodic scan reuses it.
func (c *Controller) NotifyRunnerEvent(ctx context.Context, event, subject string) {
	health, destinations, err := c.configs.ResolveRunnerHealth(ctx, c.installNamespace)
	if err != nil {
		c.log.WithError(err).Warn(ctx, "failed to resolve the runner-health notification configuration")
		return
	}
	if health == nil || len(health.Destinations) == 0 {
		return
	}
	if len(destinations) == 0 {
		return
	}
	delivery := Delivery{
		Trigger:   event,
		Subject:   subject,
		Severity:  "error",
		DedupeKey: event + "/" + c.now().UTC().Format(time.RFC3339),
	}
	outcomes := c.Deliver(ctx, c.installNamespace, destinations, health.Destinations, delivery)
	// Audit the delivery against the argo-server namespace default (the
	// runner records live there).
	c.auditObject(ctx, c.installNamespace, event, subject, outcomes)
}

// countDelivery records one delivery outcome in the metric.
func (c *Controller) countDelivery(trigger, transport, outcome string) {
	c.instruments.CountDelivery(trigger, transport, outcome)
}

// auditDelivery records one trigger's deliveries as a Kubernetes Event on
// the workflow.
func (c *Controller) auditDelivery(ctx context.Context, wf *wfv1.Workflow, trigger string, names []string, outcomes map[string]string) {
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s: %s", name, outcomes[name]))
	}
	eventType := apiv1.EventTypeNormal
	for _, outcome := range outcomes {
		if outcome != "delivered" {
			eventType = apiv1.EventTypeWarning
			break
		}
	}
	c.recordEvent(ctx, wf.Namespace, &apiv1.Event{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("%s.notify.%s", wf.Name, c.randomSuffix()),
			Namespace: wf.Namespace,
		},
		InvolvedObject: apiv1.ObjectReference{
			Kind:            "Workflow",
			Name:            wf.Name,
			Namespace:       wf.Namespace,
			UID:             wf.UID,
			APIVersion:      wfv1.SchemeGroupVersion.String(),
			ResourceVersion: wf.ResourceVersion,
		},
		Reason:  "NotificationDelivered",
		Message: fmt.Sprintf("%s notification: %s", trigger, strings.Join(parts, "; ")),
		Type:    eventType,
		Source:  apiv1.EventSource{Component: "argo-server-notify"},
	})
}

// auditObject records a runner-health delivery as a Kubernetes Event in the
// install namespace.
func (c *Controller) auditObject(ctx context.Context, namespace, event, subject string, outcomes map[string]string) {
	parts := make([]string, 0, len(outcomes))
	for name, outcome := range outcomes {
		parts = append(parts, fmt.Sprintf("%s: %s", name, outcome))
	}
	c.recordEvent(ctx, namespace, &apiv1.Event{
		ObjectMeta: metav1.ObjectMeta{
			Name:      fmt.Sprintf("runner-notify.%s", c.randomSuffix()),
			Namespace: namespace,
		},
		InvolvedObject: apiv1.ObjectReference{
			Kind:       "Secret",
			Name:       "runners",
			Namespace:  namespace,
			APIVersion: "v1",
		},
		Reason:  "RunnerNotificationDelivered",
		Message: fmt.Sprintf("%s: %s (%s)", event, subject, strings.Join(parts, "; ")),
		Type:    apiv1.EventTypeWarning,
		Source:  apiv1.EventSource{Component: "argo-server-notify"},
	})
}

// recordEvent writes one Kubernetes Event (best effort, logged on failure:
// losing an audit event must never fail the delivery it describes).
func (c *Controller) recordEvent(ctx context.Context, namespace string, event *apiv1.Event) {
	if _, err := c.kube.CoreV1().Events(namespace).Create(ctx, event, metav1.CreateOptions{}); err != nil {
		c.log.WithError(err).WithField("reason", event.Reason).Warn(ctx, "failed to record the notification audit event")
	}
}

func (c *Controller) randomSuffix() string {
	return fmt.Sprintf("%x", c.now().UnixNano()%0xffff)
}

func nonEmpty(s string) string {
	if strings.TrimSpace(s) == "" {
		return ""
	}
	return s + "\n"
}
