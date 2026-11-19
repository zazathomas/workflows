package api

import (
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"time"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/distribution/reference"
)

// RunnerTemplate is the `runner` plugin body. It is what a workflow author
// writes inside `plugin: {runner: ...}` and what the dispatcher turns into a
// JobSpec. Parsing is strict: unknown fields are rejected so that workflows
// fail fast with a clear message instead of running with a partially ignored
// template.
type RunnerTemplate struct {
	// Pool names the runner pool that may execute this template, either
	// "name" (the argo-server install namespace) or "namespace/name".
	Pool    string   `json:"pool"`
	Image   string   `json:"image"`
	Command []string `json:"command,omitempty"`
	Args    []string `json:"args,omitempty"`
	Env     []EnvVar `json:"env,omitempty"`
	// Resources limits the job container. The runner policy may further
	// reduce, but never increase, these values.
	Resources *Resources `json:"resources,omitempty"`
	// RunsOn requires capability labels on the runner ("gpu", "arm64"). A
	// job is handed only to runners whose labels include every entry.
	RunsOn []string `json:"runsOn,omitempty"`
	// Timeout is a Go duration string ("90s", "5m"). Empty or zero means no
	// deadline.
	Timeout string `json:"timeout,omitempty"`
}

type EnvVar struct {
	Name  string `json:"name"`
	Value string `json:"value,omitempty"`
	// SecretKeyRef resolves the value at claim time on the server from a
	// Secret in the workflow's namespace that is explicitly marked for
	// runner use. The runner never sees the reference, only the value.
	SecretKeyRef *SecretKeySelector `json:"secretKeyRef,omitempty"`
	// Secret marks a value that came from a Secret. Only the server sets it
	// (on the resolved wire value, never from a template): the runner uses it
	// to redact the value from the job's logs.
	Secret bool `json:"secret,omitempty"`
}

type SecretKeySelector struct {
	Name string `json:"name"`
	Key  string `json:"key"`
}

type Resources struct {
	// CPUMillis is CPU in millicores (e.g. 500 = 0.5 CPU).
	CPUMillis int64 `json:"cpuMillis,omitempty"`
	// MemoryMB is memory in megabytes.
	MemoryMB int64 `json:"memoryMB,omitempty"`
}

// TimeoutDuration returns the parsed timeout, or (0, nil) when unset.
func (t *RunnerTemplate) TimeoutDuration() (time.Duration, error) {
	if t.Timeout == "" {
		return 0, nil
	}
	d, err := time.ParseDuration(t.Timeout)
	if err != nil {
		return 0, fmt.Errorf("timeout %q is not a valid duration: %w", t.Timeout, err)
	}
	return d, nil
}

// PluginKey is the single key the plugin object must have.
const PluginKey = "runner"

// ParseRunnerTemplate extracts and validates the `runner` plugin body. The
// plugin object must have exactly one key (enforced by wfv1.Plugin), and that
// key must be "runner".
func ParseRunnerTemplate(plugin *wfv1.Plugin) (*RunnerTemplate, error) {
	if plugin == nil {
		return nil, fmt.Errorf("plugin is nil")
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(plugin.Value, &raw); err != nil {
		return nil, fmt.Errorf("plugin body is not valid JSON: %w", err)
	}
	if len(raw) != 1 {
		return nil, fmt.Errorf("plugin body must have exactly one key, got %d", len(raw))
	}
	body, ok := raw[PluginKey]
	if !ok {
		return nil, fmt.Errorf("plugin body key must be %q, got %q", PluginKey, onlyKey(raw))
	}
	t := &RunnerTemplate{}
	dec := json.NewDecoder(strings.NewReader(string(body)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(t); err != nil {
		return nil, fmt.Errorf("invalid runner template: %w", err)
	}
	if err := t.Validate(); err != nil {
		return nil, err
	}
	return t, nil
}

func onlyKey(m map[string]json.RawMessage) string {
	for k := range m {
		return k
	}
	return ""
}

var (
	envNamePattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	poolNamePattern   = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
	secretNamePattern = regexp.MustCompile(`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`)
)

// ValidateRunnerLabels checks capability labels for a runner record or a
// `runsOn` requirement: DNS labels, bounded in count and length, no
// duplicates (a duplicate is almost always a typo).
func ValidateRunnerLabels(labels []string) error {
	if len(labels) > MaxRunnerLabels {
		return fmt.Errorf("%d labels exceeds the limit of %d", len(labels), MaxRunnerLabels)
	}
	seen := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		if len(label) > MaxRunnerLabelLength {
			return fmt.Errorf("label %q exceeds %d characters", label, MaxRunnerLabelLength)
		}
		if !poolNamePattern.MatchString(label) {
			return fmt.Errorf("label %q is not a valid DNS label", label)
		}
		if _, dup := seen[label]; dup {
			return fmt.Errorf("label %q is listed twice", label)
		}
		seen[label] = struct{}{}
	}
	return nil
}

// LabelsMatch reports whether every required capability label is present in
// have. An empty requirement matches every runner.
func LabelsMatch(required, have []string) bool {
	if len(required) == 0 {
		return true
	}
	set := make(map[string]struct{}, len(have))
	for _, label := range have {
		set[label] = struct{}{}
	}
	for _, label := range required {
		if _, ok := set[label]; !ok {
			return false
		}
	}
	return true
}

// MatchesRunner reports whether a runner carrying labels may execute this
// template (every `runsOn` entry must be on the runner).
func (t *RunnerTemplate) MatchesRunner(labels []string) bool {
	return LabelsMatch(t.RunsOn, labels)
}

// PoolRef is a parsed pool reference: either "name" (argo-server install
// namespace) or "namespace/name".
type PoolRef struct {
	Namespace string
	Name      string
}

// ParsePoolRef parses a pool reference from a template.
func ParsePoolRef(s string) (PoolRef, error) {
	parts := strings.Split(s, "/")
	switch len(parts) {
	case 1:
		if !poolNamePattern.MatchString(parts[0]) {
			return PoolRef{}, fmt.Errorf("pool name %q is not a valid DNS label", parts[0])
		}
		return PoolRef{Name: parts[0]}, nil
	case 2:
		if !poolNamePattern.MatchString(parts[0]) {
			return PoolRef{}, fmt.Errorf("pool namespace %q is not a valid DNS label", parts[0])
		}
		if !poolNamePattern.MatchString(parts[1]) {
			return PoolRef{}, fmt.Errorf("pool name %q is not a valid DNS label", parts[1])
		}
		return PoolRef{Namespace: parts[0], Name: parts[1]}, nil
	default:
		return PoolRef{}, fmt.Errorf("pool must be \"name\" or \"namespace/name\", got %q", s)
	}
}

// String renders the pool reference in template form.
func (p PoolRef) String() string {
	if p.Namespace == "" {
		return p.Name
	}
	return p.Namespace + "/" + p.Name
}

// Validate validates the runner template. Everything that would make a job
// unrunnable is caught here so the dispatcher can terminalise the node with a
// clear message instead of hanging the workflow.
func (t *RunnerTemplate) Validate() error {
	if t.Pool == "" {
		return fmt.Errorf("runner template must specify a pool")
	}
	if _, err := ParsePoolRef(t.Pool); err != nil {
		return err
	}
	if t.Image == "" {
		return fmt.Errorf("runner template must specify an image")
	}
	if _, err := reference.ParseNormalizedNamed(t.Image); err != nil {
		return fmt.Errorf("image %q is not a valid reference: %w", t.Image, err)
	}
	if err := ValidateRunnerLabels(t.RunsOn); err != nil {
		return fmt.Errorf("invalid runsOn: %w", err)
	}
	if len(t.Env) > MaxEnvVars {
		return fmt.Errorf("runner template has %d env vars, limit is %d", len(t.Env), MaxEnvVars)
	}
	for _, e := range t.Env {
		if !envNamePattern.MatchString(e.Name) {
			return fmt.Errorf("env var name %q is invalid", e.Name)
		}
		if e.Secret {
			// Only the server marks resolved values; a template cannot ask
			// for redaction (nothing to gain) and must not bypass the
			// secretKeyRef rules.
			return fmt.Errorf("env var %q must not set secret (the server marks resolved Secret values)", e.Name)
		}
		if len(e.Value) > MaxEnvValueBytes {
			return fmt.Errorf("env var %q value exceeds %d bytes", e.Name, MaxEnvValueBytes)
		}
		if e.SecretKeyRef != nil {
			if e.Value != "" {
				return fmt.Errorf("env var %q cannot set both value and secretKeyRef", e.Name)
			}
			if !secretNamePattern.MatchString(e.SecretKeyRef.Name) {
				return fmt.Errorf("env var %q references a secret with an invalid name %q", e.Name, e.SecretKeyRef.Name)
			}
			if e.SecretKeyRef.Key == "" {
				return fmt.Errorf("env var %q references a secret key that is empty", e.Name)
			}
		}
	}
	if d, err := t.TimeoutDuration(); err != nil {
		return err
	} else if d < 0 {
		return fmt.Errorf("timeout must be positive, got %q", t.Timeout)
	}
	if t.Resources != nil {
		if t.Resources.CPUMillis < 0 || t.Resources.MemoryMB < 0 {
			return fmt.Errorf("resources must not be negative")
		}
	}
	return nil
}

// IsDigestPinned reports whether the image reference pins a digest.
func IsDigestPinned(image string) bool {
	ref, err := reference.ParseNormalizedNamed(image)
	if err != nil {
		return false
	}
	_, ok := ref.(reference.Digested)
	return ok
}

// ExtractOutputs builds the job output parameters from a template's output
// parameters that use valueFrom.path. Paths must be absolute and under
// /work.
func ExtractOutputs(tmpl *wfv1.Template) JobOutputs {
	var out JobOutputs
	if tmpl == nil {
		return out
	}
	for _, p := range tmpl.Outputs.Parameters {
		if p.ValueFrom == nil || p.ValueFrom.Path == "" {
			continue
		}
		out.Parameters = append(out.Parameters, JobOutputParameter{
			Name: p.Name,
			Path: p.ValueFrom.Path,
		})
	}
	for _, a := range tmpl.Outputs.Artifacts {
		if a.Path == "" {
			continue
		}
		out.Artifacts = append(out.Artifacts, JobArtifact{Name: a.Name, Path: a.Path})
	}
	return out
}

// ExtractInputs builds the job input artifacts from a template's input
// artifacts with paths. Locations are resolved server-side at download time.
func ExtractInputs(tmpl *wfv1.Template) JobInputs {
	var in JobInputs
	if tmpl == nil {
		return in
	}
	for _, a := range tmpl.Inputs.Artifacts {
		if a.Path == "" {
			continue
		}
		in.Artifacts = append(in.Artifacts, JobArtifact{Name: a.Name, Path: a.Path})
	}
	return in
}

// ValidateOutputPath checks a job output parameter path: absolute, under
// /work, no traversal out of it.
func ValidateOutputPath(p JobOutputParameter) error {
	if p.Name == "" {
		return fmt.Errorf("output parameter name is empty")
	}
	if err := validateWorkspacePath(p.Path); err != nil {
		return fmt.Errorf("output parameter %q path %q must be under %s", p.Name, p.Path, WorkspacePath)
	}
	return nil
}

// ValidateArtifactPath checks a job artifact path (input or output):
// absolute, under /work, no traversal out of it.
func ValidateArtifactPath(a JobArtifact) error {
	if a.Name == "" {
		return fmt.Errorf("artifact name is empty")
	}
	if err := validateWorkspacePath(a.Path); err != nil {
		return fmt.Errorf("artifact %q path %q must be under %s", a.Name, a.Path, WorkspacePath)
	}
	return nil
}

// validateWorkspacePath checks that path is absolute, under WorkspacePath,
// and cannot traverse out of it.
func validateWorkspacePath(p string) error {
	if !strings.HasPrefix(p, WorkspacePath) {
		return fmt.Errorf("not under %s", WorkspacePath)
	}
	suffix := strings.TrimPrefix(p, WorkspacePath)
	if suffix != "" && !strings.HasPrefix(suffix, "/") {
		return fmt.Errorf("not under %s", WorkspacePath)
	}
	if strings.Contains(suffix, "..") {
		return fmt.Errorf("must not contain ..")
	}
	return nil
}

// validateResult checks phases, sizes and output parameter shape.
func validateResult(r *Result) error {
	switch r.Phase {
	case PhaseSucceeded, PhaseFailed, PhaseError:
	default:
		return fmt.Errorf("result phase must be one of %s, %s, %s", PhaseSucceeded, PhaseFailed, PhaseError)
	}
	if len(r.Message) > MaxMessageBytes {
		return fmt.Errorf("result message exceeds %d bytes", MaxMessageBytes)
	}
	total := 0
	for _, p := range r.OutputParameters {
		if p.Name == "" {
			return fmt.Errorf("output parameter name is empty")
		}
		if len(p.Value) > MaxOutputParameterBytes {
			return fmt.Errorf("output parameter %q value exceeds %d bytes", p.Name, MaxOutputParameterBytes)
		}
		total += len(p.Value)
	}
	if total > MaxTotalOutputBytes {
		return fmt.Errorf("total output parameters exceed %d bytes", MaxTotalOutputBytes)
	}
	return nil
}
