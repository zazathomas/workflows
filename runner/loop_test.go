package runner

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// fakeServer implements just enough of the runner endpoints for the loop.
type fakeServer struct {
	mu sync.Mutex
	// claims is the queue of jobs handed out; empty claim returns no job.
	claims            []*api.JobSpec
	results           []api.ResultRequest
	logChunks         []api.LogChunkRequest
	heartbeats        int
	stopHeartbeat     bool
	heartbeatContinue bool
}

func (f *fakeServer) handler(t *testing.T) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/extensions/runners/v1/claim", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		var job *api.JobSpec
		if len(f.claims) > 0 {
			job = f.claims[0]
			f.claims = f.claims[1:]
		}
		f.mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.ClaimResponse{Job: job})
	})
	mux.HandleFunc("/api/v1/extensions/runners/v1/heartbeat", func(w http.ResponseWriter, r *http.Request) {
		var req api.HeartbeatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.heartbeats++
		cont := !f.stopHeartbeat && f.heartbeatContinue
		f.mu.Unlock()
		_ = json.NewEncoder(w).Encode(api.HeartbeatResponse{Continue: cont})
	})
	mux.HandleFunc("/api/v1/extensions/runners/v1/logs", func(w http.ResponseWriter, r *http.Request) {
		var req api.LogChunkRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.logChunks = append(f.logChunks, req)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/api/v1/extensions/runners/v1/result", func(w http.ResponseWriter, r *http.Request) {
		var req api.ResultRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		f.results = append(f.results, req)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	return mux
}

func testLoop(t *testing.T, server *fakeServer, docker *fakeDocker, once bool) *Loop {
	t.Helper()
	ts := httptest.NewServer(server.handler(t))
	t.Cleanup(ts.Close)
	priv := testKey(t)
	client, err := NewClient(ts.URL, priv, "r-1")
	require.NoError(t, err)
	client.http.Timeout = 5 * time.Second
	return NewLoop(LoopConfig{
		Client:   client,
		Executor: NewExecutor(docker, testPolicy()),
		Log:      logging.NewTestLogger(logging.Info, logging.Text),
		Once:     once,
		// Fast polling for tests.
		ClaimInterval: 10 * time.Millisecond,
		HeartbeatGap:  5 * time.Millisecond,
	})
}

func testKey(t *testing.T) ed25519.PrivateKey {
	t.Helper()
	_, priv, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	return priv
}

func TestLoopRunsOneJobAndExitsOnce(t *testing.T) {
	docker := newFakeDocker()
	docker.files["/work/message.txt"] = "hello\n"
	server := &fakeServer{claims: []*api.JobSpec{testJob()}, heartbeatContinue: true}

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	loop := testLoop(t, server, docker, true)
	err := loop.Run(ctx)
	require.NoError(t, err)

	// The job ran and its result was submitted.
	require.Len(t, server.results, 1)
	assert.Equal(t, api.PhaseSucceeded, server.results[0].Result.Phase)
	// The container log was streamed in ordered chunks before the result.
	require.NotEmpty(t, server.logChunks, "the job log is streamed")
	var stream []byte
	for _, chunk := range server.logChunks {
		stream = append(stream, chunk.Data...)
	}
	assert.Equal(t, "hello from the job\n", string(stream))
	assert.Len(t, server.results[0].Result.OutputParameters, 1)
	assert.Equal(t, "hello", server.results[0].Result.OutputParameters[0].Value)
	assert.Equal(t, testJob().ID, server.results[0].JobID)
	assert.Equal(t, "job-token", server.results[0].Token)
}

func TestLoopHeartbeatStopCancelsJob(t *testing.T) {
	docker := newFakeDocker()
	docker.blockUntilCancel = true
	server := &fakeServer{claims: []*api.JobSpec{testJob()}, heartbeatContinue: false}

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	loop := testLoop(t, server, docker, true)
	require.NoError(t, loop.Run(ctx))

	// The server said stop: the executor was cancelled, and the (failed)
	// result still reached the server.
	require.Len(t, server.results, 1)
	assert.Equal(t, api.PhaseFailed, server.results[0].Result.Phase)
	assert.Contains(t, server.results[0].Result.Message, "cancelled")
}

func TestLoopPermanentErrorStops(t *testing.T) {
	docker := newFakeDocker()

	// A server that always rejects claims with 403 (revoked runner).
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer ts.Close()
	priv := testKey(t)
	client, err := NewClient(ts.URL, priv, "r-1")
	require.NoError(t, err)
	loop := NewLoop(LoopConfig{
		Client:        client,
		Executor:      NewExecutor(docker, testPolicy()),
		Log:           logging.NewTestLogger(logging.Info, logging.Text),
		Once:          true,
		ClaimInterval: 5 * time.Millisecond,
	})

	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	err = loop.Run(ctx)
	require.Error(t, err)
	var httpErr *HTTPError
	require.ErrorAs(t, err, &httpErr)
	assert.Equal(t, http.StatusForbidden, httpErr.Status)
}

func TestClientSignsEveryRequest(t *testing.T) {
	server := &fakeServer{claims: []*api.JobSpec{testJob()}, heartbeatContinue: true}
	ts := httptest.NewServer(server.handler(t))
	defer ts.Close()

	priv := testKey(t)
	client, err := NewClient(ts.URL, priv, "r-1")
	require.NoError(t, err)
	resp, err := client.Claim(t.Context())
	require.NoError(t, err)
	require.NotNil(t, resp.Job)
	assert.NotEmpty(t, resp.Job.ID)
}
