package runner

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

// fakeCosign writes a shell script that succeeds for images containing
// "good" and fails otherwise, and returns its path (plus a key path).
func fakeCosign(t *testing.T, body string) (binary string, key string) {
	t.Helper()
	dir := t.TempDir()
	binary = filepath.Join(dir, "cosign")
	require.NoError(t, os.WriteFile(binary, []byte("#!/bin/sh\n"+body), 0o755))
	key = filepath.Join(dir, "cosign.pub")
	require.NoError(t, os.WriteFile(key, []byte("-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n"), 0o600))
	return binary, key
}

func TestCosignVerification(t *testing.T) {
	job := testJob()

	// No keys pinned: no verification is performed at all.
	p := testPolicy()
	executor := NewExecutor(newFakeDocker(), p)
	assert.NoError(t, executor.verifyImage(t.Context(), job))

	binary, key := fakeCosign(t, `exit 0`)
	p = testPolicy()
	p.CosignKeys = []string{key}
	p.CosignPath = binary

	// A digest-pinned image passes the fake verifier.
	executor = NewExecutor(newFakeDocker(), p)
	assert.NoError(t, executor.verifyImage(t.Context(), job))

	// Execute-level: a failing verification fails the job before any
	// container exists (fail closed).
	failBinary, failKey := fakeCosign(t, `echo "signature verification failed" >&2; exit 1`)
	p = testPolicy()
	p.CosignKeys = []string{failKey}
	p.CosignPath = failBinary
	docker := newFakeDocker()
	executor = NewExecutor(docker, p)
	result := executor.Execute(t.Context(), job)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "cosign")
	assert.Empty(t, docker.created, "no container may be created before verification passes")

	// Missing cosign binary: fail closed, not open.
	p2 := testPolicy()
	p2.CosignKeys = []string{key}
	p2.CosignPath = filepath.Join(t.TempDir(), "does-not-exist")
	executor = NewExecutor(newFakeDocker(), p2)
	result = executor.Execute(t.Context(), job)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "cosign")

	// Tag-based images are refused: verification must cover the exact
	// artifact, so it needs the digest.
	p3 := testPolicy()
	p3.CosignKeys = []string{failKey}
	p3.CosignPath = failBinary
	tagged := *job
	tagged.Task.Image = "docker.io/library/busybox:latest"
	executor = NewExecutor(newFakeDocker(), p3)
	result = executor.Execute(t.Context(), &tagged)
	assert.Equal(t, api.PhaseError, result.Phase)
	assert.Contains(t, result.Message, "digest-pinned")

	// A slow verifier is bounded by the timeout.
	slowBinary, slowKey := fakeCosign(t, `sleep 5; exit 0`)
	p4 := testPolicy()
	p4.CosignKeys = []string{slowKey}
	p4.CosignPath = slowBinary
	p4.CosignTimeout = 1 // 1ns: effectively immediate timeout
	executor = NewExecutor(newFakeDocker(), p4)
	timeoutErr := executor.verifyImage(t.Context(), job)
	require.Error(t, timeoutErr)
	assert.Contains(t, timeoutErr.Error(), "timed out")
}

// Every pinned key gets a chance: an image signed by the second key must
// verify even though the first key does not match it.
func TestCosignVerificationTriesEveryPinnedKey(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "cosign")
	// Args: verify --key <KEY> --insecure-ignore-tlog <IMAGE>
	script := `#!/bin/sh
case "$3" in
  *second.pub) echo verified; exit 0 ;;
  *) echo "no matching signatures" >&2; exit 1 ;;
esac
`
	require.NoError(t, os.WriteFile(binary, []byte(script), 0o755))
	first := filepath.Join(dir, "first.pub")
	second := filepath.Join(dir, "second.pub")
	for _, key := range []string{first, second} {
		require.NoError(t, os.WriteFile(key, []byte("-----BEGIN PUBLIC KEY-----\nfake\n-----END PUBLIC KEY-----\n"), 0o600))
	}

	p := testPolicy()
	p.CosignKeys = []string{first, second}
	p.CosignPath = binary
	assert.NoError(t, NewExecutor(newFakeDocker(), p).verifyImage(t.Context(), testJob()),
		"the second pinned key verifies the image")

	// When no pinned key verifies it, the job is rejected with the reason.
	p.CosignKeys = []string{first}
	err := NewExecutor(newFakeDocker(), p).verifyImage(t.Context(), testJob())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "every pinned key")
}
