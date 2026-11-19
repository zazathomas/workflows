package runner

import (
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/distribution/reference"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

// Policy is the operator's runner-local policy. It is owned by the operator
// (a file on the runner host) and can only restrict what the control plane
// asks for, never loosen it (section 4 of the runners plan).
type Policy struct {
	// AllowedRegistries lists the registries jobs may pull from. An empty
	// list allows no registry (every job fails).
	AllowedRegistries []string `json:"allowedRegistries"`
	// RequireDigest rejects images that are not digest-pinned, even when the
	// pool does not require it.
	RequireDigest bool `json:"requireDigest"`
	// AllowRoot permits running job containers as root. Default false: jobs
	// run as an unprivileged user.
	AllowRoot bool `json:"allowRoot"`
	// AllowEgress permits job containers to reach networks outside their
	// per-job network. Default false: per-job networks are internal. With it
	// enabled, job containers can also reach whatever the runner host can,
	// including cloud metadata services (169.254.169.254) and private
	// ranges: there is no destination allow-list. Enable it only for trusted
	// workflow authors.
	AllowEgress bool `json:"allowEgress"`
	// Runtime is the OCI runtime for job containers (e.g. "runsc",
	// "sysbox-runc"). Empty uses the daemon default.
	Runtime string `json:"runtime"`
	// JobSigners pins the Ed25519 public keys (base64 std, 32 bytes) whose
	// job-spec signatures the runner accepts. When non-empty, every claimed
	// job must carry a signature by one of these keys (produced by an
	// operator-run signer such as `argo-runner gate`; argo-server holds no
	// signer key). Default empty: no signatures required.
	JobSigners []string `json:"jobSigners"`
	// CosignKeys are paths to public key files. When non-empty, every job
	// image must verify against one of them with the cosign binary before
	// the container is created (fail closed when cosign is missing).
	// Images must be digest-pinned: the verification then covers the exact
	// artifact the runner pulls.
	CosignKeys []string `json:"cosignKeys"`
	// CosignPath is the cosign binary (default "cosign" from PATH). The
	// operator installs it on the runner host.
	CosignPath string `json:"cosignPath"`
	// CosignTimeout bounds one cosign verify run. Default 30s.
	CosignTimeout time.Duration `json:"cosignTimeout"`
	// MaxCPUMillis and MaxMemoryMB are ceilings on what a job may request.
	MaxCPUMillis int64 `json:"maxCPUMillis"`
	MaxMemoryMB  int64 `json:"maxMemoryMB"`
	// DefaultCPUMillis and DefaultMemoryMB are applied when a job omits
	// resources (defaults: 1000 mCPU and 1024 MB). A job therefore never runs
	// unbounded, even when the (untrusted) workflow author leaves resources
	// out.
	DefaultCPUMillis int64 `json:"defaultCPUMillis"`
	DefaultMemoryMB  int64 `json:"defaultMemoryMB"`
	// WorkspaceMB caps the per-job workspace volume (default 1024). Docker's
	// local volume driver cannot enforce a quota on every host, so the runner
	// warns when the daemon refuses the size option and the job keeps an
	// unbounded workspace; use a driver with quota support to enforce it.
	WorkspaceMB int64 `json:"workspaceMB"`
}

// Defaults for a job that omits resources and for the workspace quota.
const (
	defaultJobCPUMillis = 1000
	defaultJobMemoryMB  = 1024
	defaultWorkspaceMB  = 1024
)

// jobResources returns the CPU millis and memory MB the job container gets:
// what the job asked for, or the operator's defaults, never above the
// operator's ceilings.
func (p *Policy) jobResources(job *api.JobSpec) (cpuMillis, memMB int64) {
	cpuMillis, memMB = p.DefaultCPUMillis, p.DefaultMemoryMB
	if cpuMillis <= 0 {
		cpuMillis = defaultJobCPUMillis
	}
	if memMB <= 0 {
		memMB = defaultJobMemoryMB
	}
	if job.Task.Resources != nil {
		if job.Task.Resources.CPUMillis > 0 {
			cpuMillis = job.Task.Resources.CPUMillis
		}
		if job.Task.Resources.MemoryMB > 0 {
			memMB = job.Task.Resources.MemoryMB
		}
	}
	if p.MaxCPUMillis > 0 && cpuMillis > p.MaxCPUMillis {
		cpuMillis = p.MaxCPUMillis
	}
	if p.MaxMemoryMB > 0 && memMB > p.MaxMemoryMB {
		memMB = p.MaxMemoryMB
	}
	return cpuMillis, memMB
}

// workspaceMB returns the workspace quota to request from the volume driver.
func (p *Policy) workspaceMB() int64 {
	if p.WorkspaceMB <= 0 {
		return defaultWorkspaceMB
	}
	return p.WorkspaceMB
}

// JobSignerKeys decodes the pinned job-spec signer keys.
func (p *Policy) JobSignerKeys() ([]ed25519.PublicKey, error) {
	keys := make([]ed25519.PublicKey, 0, len(p.JobSigners))
	for _, encoded := range p.JobSigners {
		key, err := api.DecodePublicKey(encoded)
		if err != nil {
			return nil, fmt.Errorf("parsing jobSigners entry: %w", err)
		}
		keys = append(keys, key)
	}
	return keys, nil
}

// DefaultPolicy is the most restrictive policy.
func DefaultPolicy() Policy {
	return Policy{}
}

// LoadPolicy reads a policy file. A missing file is an error: the runner must
// not fall back to a default that might be looser than the operator intends.
func LoadPolicy(path string) (Policy, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Policy{}, fmt.Errorf("reading policy file (runners are not allowed to start without one): %w", err)
	}
	p := DefaultPolicy()
	dec := json.NewDecoder(strings.NewReader(string(data)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&p); err != nil {
		return Policy{}, fmt.Errorf("parsing policy file %s: %w", path, err)
	}
	return p, nil
}

// CheckJob verifies a job against the policy before any container is
// created. When the policy pins job-spec signer keys, the job must carry a
// valid signature by one of them. The signature proves the spec came through
// the operator's signer; it does not prove a trusted party composed it (the
// gate signs what argo-server sends), so the runner-local checks below, the
// registry allow-list and the sandbox runtime remain the real limits on what
// a job may do.
func (p *Policy) CheckJob(job *api.JobSpec) error {
	if len(p.JobSigners) > 0 {
		keys, err := p.JobSignerKeys()
		if err != nil {
			return err
		}
		if !api.VerifyJobSpecSignature(job, job.SpecSignature, keys) {
			return fmt.Errorf("job spec has no valid signature by a pinned job-signer key (is the gate running, and is its key pinned?)")
		}
	}
	named, err := reference.ParseNormalizedNamed(job.Task.Image)
	if err != nil {
		return fmt.Errorf("job image %q is not a valid reference", job.Task.Image)
	}
	registry := reference.Domain(named)
	allowed := false
	for _, r := range p.AllowedRegistries {
		if r == registry || (r == "docker.io" && registry == "index.docker.io") || (r == "index.docker.io" && registry == "docker.io") {
			allowed = true
			break
		}
	}
	if !allowed {
		return fmt.Errorf("registry %q is not in the runner allow-list", registry)
	}
	if p.RequireDigest && !api.IsDigestPinned(job.Task.Image) {
		return fmt.Errorf("image %q is not digest-pinned (runner requires digests)", job.Task.Image)
	}
	if p.MaxCPUMillis > 0 && job.Task.Resources != nil && job.Task.Resources.CPUMillis > p.MaxCPUMillis {
		return fmt.Errorf("job requests %d CPU millis, runner ceiling is %d", job.Task.Resources.CPUMillis, p.MaxCPUMillis)
	}
	if p.MaxMemoryMB > 0 && job.Task.Resources != nil && job.Task.Resources.MemoryMB > p.MaxMemoryMB {
		return fmt.Errorf("job requests %d MB memory, runner ceiling is %d", job.Task.Resources.MemoryMB, p.MaxMemoryMB)
	}
	for _, output := range job.Task.Outputs.Parameters {
		if err := api.ValidateOutputPath(output); err != nil {
			return err
		}
	}
	return nil
}
