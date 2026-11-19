package runner

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	mobyclient "github.com/moby/moby/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
)

// TestIntegrationExecutorRunsRealContainers runs the executor against a real
// Docker daemon. It is skipped unless RUNNER_DOCKER_INTEGRATION is set and
// DOCKER_HOST points at a throwaway daemon (CI runs it against a DinD service
// container; never the developer host socket, per the repo rules).
func TestIntegrationExecutorRunsRealContainers(t *testing.T) {
	if os.Getenv("RUNNER_DOCKER_INTEGRATION") == "" {
		t.Skip("set RUNNER_DOCKER_INTEGRATION=1 and DOCKER_HOST to a throwaway daemon to run this test")
	}

	docker, err := NewMobyDocker(t.Context(), os.Getenv("DOCKER_HOST"))
	require.NoError(t, err)
	policy := Policy{AllowedRegistries: []string{"docker.io"}}
	executor := NewExecutor(docker, policy)

	job := &api.JobSpec{
		ID:       "integration-test",
		Pool:     "test",
		Workflow: api.WorkflowRef{UID: "uid", Name: "wf", Namespace: "ns"},
		NodeID:   "node",
		Task: api.JobTemplate{
			// Pinned busybox: the job proves a real container ran (exit code,
			// outputs, cleanup) without depending on a mutable tag.
			Image:   "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
			Command: []string{"sh", "-c"},
			Args:    []string{"echo -n integration-ok > /work/message.txt; echo hello; exit 0"},
			Outputs: api.JobOutputs{Parameters: []api.JobOutputParameter{{Name: "msg", Path: "/work/message.txt"}}},
		},
		Token: "token",
	}

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	result := executor.Execute(ctx, job)

	require.Equal(t, api.PhaseSucceeded, result.Phase, "message: %s", result.Message)
	require.Len(t, result.OutputParameters, 1)
	assert.Equal(t, "integration-ok", result.OutputParameters[0].Value)

	// The job container was cleaned up.
	assert.Empty(t, leftoverContainers(t, job.ID), "the job container is removed")
}

// TestIntegrationExecutorFailsHardenedRoot proves the hardening defaults
// apply to a real daemon: a job that needs privileges (writing outside the
// workspace) fails rather than escaping.
func TestIntegrationExecutorFailsHardenedRoot(t *testing.T) {
	if os.Getenv("RUNNER_DOCKER_INTEGRATION") == "" {
		t.Skip("set RUNNER_DOCKER_INTEGRATION=1 and DOCKER_HOST to a throwaway daemon to run this test")
	}

	docker, err := NewMobyDocker(t.Context(), os.Getenv("DOCKER_HOST"))
	require.NoError(t, err)
	executor := NewExecutor(docker, Policy{AllowedRegistries: []string{"docker.io"}})

	job := &api.JobSpec{
		ID:       "integration-hardened",
		Pool:     "test",
		Workflow: api.WorkflowRef{UID: "uid", Name: "wf", Namespace: "ns"},
		NodeID:   "node",
		Task: api.JobTemplate{
			Image:   "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec",
			Command: []string{"sh", "-c"},
			// The root filesystem is read-only and all capabilities are
			// dropped, so this must fail instead of succeeding as root.
			Args: []string{"touch /owned-by-job || exit 42"},
		},
		Token: "token",
	}

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Minute)
	defer cancel()
	result := executor.Execute(ctx, job)

	assert.Equal(t, api.PhaseFailed, result.Phase)
	assert.Contains(t, result.Message, "42")
	assert.Empty(t, leftoverContainers(t, job.ID), "the job container is removed")
}

// leftoverContainers lists leftover containers whose name starts with the
// job's sanitized prefix (the executor names job containers after the job).
func leftoverContainers(t *testing.T, jobID string) []string {
	t.Helper()
	cli, err := mobyclient.NewClientWithOpts(mobyclient.FromEnv, mobyclient.WithAPIVersionNegotiation())
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	list, err := cli.ContainerList(ctx, mobyclient.ContainerListOptions{All: true})
	require.NoError(t, err)
	prefix := "argo-runner-" + sanitizeName(jobID)
	var names []string
	for _, item := range list.Items {
		for _, name := range item.Names {
			if strings.HasPrefix(strings.TrimPrefix(name, "/"), prefix) {
				names = append(names, name)
			}
		}
	}
	return names
}
