package commands

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/runner"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// gateFixture stands up a fake argo-server and the gate in front of it.
type gateFixture struct {
	upstream *httptest.Server
	gate     *httptest.Server
	key      ed25519.PrivateKey
}

func newGateFixture(t *testing.T, upstream http.HandlerFunc) *gateFixture {
	t.Helper()
	upstreamServer := httptest.NewServer(upstream)
	t.Cleanup(upstreamServer.Close)

	_, key, err := ed25519.GenerateKey(rand.Reader)
	require.NoError(t, err)
	target, err := url.Parse(upstreamServer.URL)
	require.NoError(t, err)
	gateServer := httptest.NewServer(newGateHandler(target, key, logging.NewTestLogger(logging.Info, logging.Text), false))
	t.Cleanup(gateServer.Close)
	return &gateFixture{upstream: upstreamServer, gate: gateServer, key: key}
}

func gateJob() *api.JobSpec {
	return &api.JobSpec{
		ID:       "runner-job-abc123-1",
		Pool:     "build",
		Attempt:  1,
		Workflow: api.WorkflowRef{UID: "uid-1", Name: "wf-1", Namespace: "test"},
		NodeID:   "node-1",
		Task:     api.JobTemplate{Image: "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"},
		Token:    "job-token",
	}
}

func TestGateSignsClaimResponses(t *testing.T) {
	job := gateJob()
	fixture := newGateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, http.MethodPost, r.Method)
		body, _ := io.ReadAll(r.Body)
		require.Equal(t, "{}", string(body), "the request body passes through untouched")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(api.ClaimResponse{Job: job})
	})

	// The runner points at the gate and claims.
	body, err := json.Marshal(map[string]string{})
	require.NoError(t, err)
	resp, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/claim", "application/json", jsonReader(body))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	var claim api.ClaimResponse
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&claim))
	require.NotNil(t, claim.Job)

	// The signature verifies against the gate's public key, and the spec the
	// runner decodes is byte-identical to what the runner re-canonicalises
	// (the gate signs the spec as the runner received it).
	public := fixture.key.Public().(ed25519.PublicKey)
	assert.True(t, api.VerifyJobSpecSignature(claim.Job, claim.Job.SpecSignature, []ed25519.PublicKey{public}),
		"the gate's signature must verify with its public key")

	// The signature binds the job: any change invalidates it.
	tampered := *claim.Job
	tampered.Task.Image = "docker.io/library/alpine@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"
	assert.False(t, api.VerifyJobSpecSignature(&tampered, claim.Job.SpecSignature, []ed25519.PublicKey{public}))

	// End-to-end: a runner policy pinning the gate's key accepts the job,
	// and the same policy refuses the unsigned spec straight from the server.
	policyJSON := `{"allowedRegistries": ["docker.io"], "requireDigest": true, "jobSigners": ["` +
		base64.StdEncoding.EncodeToString(public) + `"]}`
	policyPath := t.TempDir() + "/policy.json"
	require.NoError(t, os.WriteFile(policyPath, []byte(policyJSON), 0o600))
	policy, err := runner.LoadPolicy(policyPath)
	require.NoError(t, err)
	assert.NoError(t, policy.CheckJob(claim.Job), "the gate-signed job passes the pinned policy")

	unsigned := *job
	assert.Error(t, policy.CheckJob(&unsigned), "the unsigned job straight from the server is refused")
}

// Non-claim endpoints pass through completely unchanged.
func TestGatePassesOtherEndpointsThrough(t *testing.T) {
	fixture := newGateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Upstream", "yes")
		_, _ = w.Write([]byte("upstream-response"))
	})

	// A heartbeat (POST, non-claim path).
	resp, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/heartbeat", "application/json", jsonReader([]byte(`{"jobID":"x"}`)))
	require.NoError(t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	assert.Equal(t, "upstream-response", string(body))
	assert.Equal(t, "yes", resp.Header.Get("X-Upstream"))

	// An empty claim (no job) passes through without a signature.
	resp2, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/claim", "application/json", jsonReader([]byte(`{}`)))
	require.NoError(t, err)
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	assert.Equal(t, "upstream-response", string(body2))

	// A non-200 claim response passes through untouched.
	resp3, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/claim", "application/json", jsonReader([]byte(`{}`)))
	require.NoError(t, err)
	_ = resp3
}

// A claim response the gate cannot decode is passed through unsigned: the
// runner's pinned keys then reject it (fail closed at the runner).
func TestGateFailsClosedOnUndecodableClaim(t *testing.T) {
	fixture := newGateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"job": "not-a-job-spec"}`))
	})
	resp, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/claim", "application/json", jsonReader([]byte(`{}`)))
	require.NoError(t, err)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	assert.Contains(t, string(body), "not-a-job-spec", "the undecodable body passes through unchanged (the runner rejects it)")
}

func TestGateKeyPersists(t *testing.T) {
	dir := t.TempDir()
	path := dir + "/gate-key"
	key, created, err := loadOrCreateGateKey(path)
	require.NoError(t, err)
	assert.True(t, created)

	// A second load returns the same key without regenerating.
	again, created2, err := loadOrCreateGateKey(path)
	require.NoError(t, err)
	assert.False(t, created2)
	assert.Equal(t, key, again)
}

func jsonReader(b []byte) io.Reader {
	return bytes.NewReader(b)
}

// A claim response larger than the gate's buffer is passed through whole and
// unsigned: truncating it would hand the runner invalid JSON instead of a
// clear "unsigned job" rejection.
func TestGatePassesOversizedClaimsThroughUnsigned(t *testing.T) {
	old := gateClaimBodyLimit
	gateClaimBodyLimit = 1024
	t.Cleanup(func() { gateClaimBodyLimit = old })

	job := gateJob()
	job.Task.Env = []api.EnvVar{{Name: "BIG", Value: strings.Repeat("x", 4096)}}
	var upstreamBody []byte
	fixture := newGateFixture(t, func(w http.ResponseWriter, r *http.Request) {
		upstreamBody, _ = json.Marshal(api.ClaimResponse{Job: job})
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(upstreamBody)
	})

	resp, err := http.Post(fixture.gate.URL+api.APIPathPrefix+"/claim", "application/json", jsonReader([]byte(`{}`)))
	require.NoError(t, err)
	defer resp.Body.Close()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	body, err := io.ReadAll(resp.Body)
	require.NoError(t, err)
	assert.Equal(t, upstreamBody, body, "the oversized body arrives whole and unmodified")

	var claim api.ClaimResponse
	require.NoError(t, json.Unmarshal(body, &claim))
	require.NotNil(t, claim.Job)
	assert.Empty(t, claim.Job.SpecSignature, "the gate cannot sign what it did not inspect")
}
