package runner

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

// defaultCosignTimeout bounds one cosign verify run.
const defaultCosignTimeout = 30 * time.Second

// verifyImage checks a job image with the cosign binary against the keys
// pinned in the runner-local policy (fail closed: a missing binary, a
// timeout or a failed verification all reject the job). Images must be
// digest-pinned, so the verification covers the exact artifact the runner
// pulls. The transparency log is not required (--insecure-ignore-tlog): the
// signature is checked against the pinned public keys only, so a stolen
// signing key is enough to sign an image (the operator's keys are the whole
// trust anchor).
func (e *Executor) verifyImage(ctx context.Context, job *api.JobSpec) error {
	if len(e.policy.CosignKeys) == 0 {
		return nil
	}
	if !api.IsDigestPinned(job.Task.Image) {
		return fmt.Errorf("image %q is not digest-pinned (cosign verification requires digests)", job.Task.Image)
	}
	cosign := e.policy.CosignPath
	if cosign == "" {
		cosign = "cosign"
	}
	timeout := e.policy.CosignTimeout
	if timeout <= 0 {
		timeout = defaultCosignTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	var failures []string
	for _, key := range e.policy.CosignKeys {
		// Every pinned key gets a chance: an image signed by the second key
		// must verify when the first one does not match. Verification fails
		// only when no pinned key verifies it.
		cmd := exec.CommandContext(ctx, cosign, "verify", "--key", key, "--insecure-ignore-tlog", job.Task.Image)
		if output, err := cmd.CombinedOutput(); err != nil {
			if ctx.Err() == context.DeadlineExceeded {
				return fmt.Errorf("cosign verification timed out after %s", timeout)
			}
			failures = append(failures, fmt.Sprintf("%s: %s", key, firstLine(string(output))))
			continue
		}
		return nil
	}
	return fmt.Errorf("cosign verification of %s failed against every pinned key (%s)", job.Task.Image, strings.Join(failures, "; "))
}

// firstLine keeps error messages bounded.
func firstLine(s string) string {
	for i, r := range s {
		if r == '\n' {
			return s[:i]
		}
	}
	if len(s) > 200 {
		return s[:200]
	}
	return s
}
