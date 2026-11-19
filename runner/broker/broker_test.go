package broker

import (
	"bytes"
	"crypto/ed25519"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	argo "github.com/argoproj/argo-workflows/v4/pkg/plugins/executor"
	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/runner"
)

const testImage = "docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec"

func TestPluginAuthAndRouting(t *testing.T) {
	tokenFile := filepath.Join(t.TempDir(), "token")
	require.NoError(t, os.WriteFile(tokenFile, []byte("argo-secret\n"), 0600))
	p, err := NewPlugin("https://broker.example", strings.Repeat("x", 40), tokenFile, "builds", "build")
	require.NoError(t, err)
	for _, tc := range []struct {
		token, body string
		code        int
		response    string
	}{
		{"bad", `{}`, 403, "forbidden"},
		{"argo-secret", `{"workflow":{"metadata":{}},"template":{"plugin":{"another":{}}}}`, 200, `{}`},
		{"argo-secret", `{"workflow":{"metadata":{"namespace":"elsewhere"}},"template":{"plugin":{"runner":{"pool":"build","image":"` + testImage + `","node":"wf"}}}}`, 200, `"phase":"Error"`},
	} {
		req := httptest.NewRequest(http.MethodPost, PluginPath, strings.NewReader(tc.body))
		req.Header.Set("Authorization", "Bearer "+tc.token)
		w := httptest.NewRecorder()
		p.ServeHTTP(w, req)
		require.Equal(t, tc.code, w.Code)
		require.Contains(t, w.Body.String(), tc.response)
	}
}

func TestPostgresBrokerLifecycle(t *testing.T) {
	dsn := os.Getenv("BROKER_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("set BROKER_TEST_DATABASE_URL to a disposable PostgreSQL database")
	}
	ctx := t.Context()
	db, err := sql.Open("postgres", dsn)
	require.NoError(t, err)
	defer func() { _ = db.Close() }()
	require.NoError(t, Migrate(ctx, db))
	require.NoError(t, Migrate(ctx, db))
	namespace := "test-" + api.RandomHex(6)
	token := api.RandomHex(32)
	cfg := Config{Namespace: namespace, Pool: "build", PluginToken: token, Concurrency: 1}
	first, err := NewServer(db, cfg)
	require.NoError(t, err)
	second, err := NewServer(db, cfg)
	require.NoError(t, err)
	h1, h2 := httptest.NewTLSServer(first), httptest.NewTLSServer(second)
	defer h1.Close()
	defer h2.Close()
	enroll := func(h *httptest.Server) (*runner.Client, ed25519.PrivateKey, string) {
		j, err := first.Mint(ctx, time.Minute)
		require.NoError(t, err)
		pub, key, err := ed25519.GenerateKey(nil)
		require.NoError(t, err)
		unsigned, err := runner.NewClientWithTLS(h.URL, nil, "", h.Client().Transport.(*http.Transport).TLSClientConfig)
		require.NoError(t, err)
		info, err := unsigned.Enrol(ctx, pub, j, "host", "test", "native", nil, nil)
		require.NoError(t, err)
		_, err = unsigned.Enrol(ctx, pub, j, "host", "test", "native", nil, nil)
		require.Error(t, err)
		signed, err := runner.NewClientWithTLS(h.URL, key, info.RunnerID, h.Client().Transport.(*http.Transport).TLSClientConfig)
		require.NoError(t, err)
		return signed, key, info.RunnerID
	}
	a, _, _ := enroll(h1)
	b, _, _ := enroll(h2)
	tokenFile := filepath.Join(t.TempDir(), "argo-token")
	require.NoError(t, os.WriteFile(tokenFile, []byte("argo-token"), 0600))
	plugin, err := NewPlugin(h1.URL, token, tokenFile, namespace, cfg.Pool)
	require.NoError(t, err)
	plugin.client = h1.Client()
	payload := `{"workflow":{"metadata":{"namespace":"` + namespace + `","uid":"wf-test","name":"workflow"}},"template":{"inputs":{"artifacts":[{"name":"source","path":"/work/in","raw":{"data":"hello"}}]},"outputs":{"parameters":[{"name":"message","valueFrom":{"path":"/work/msg"}}],"artifacts":[{"name":"report","path":"/work/out"}]},"plugin":{"runner":{"pool":"build","image":"` + testImage + `","node":"workflow.remote","timeout":"5m"}}}}`
	poll := func() argo.ExecuteTemplateReply {
		req := httptest.NewRequest(http.MethodPost, PluginPath, strings.NewReader(payload))
		req.Header.Set("Authorization", "Bearer argo-token")
		w := httptest.NewRecorder()
		plugin.ServeHTTP(w, req)
		require.Equal(t, 200, w.Code, w.Body.String())
		var out argo.ExecuteTemplateReply
		require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
		require.NotNil(t, out.Node)
		return out
	}
	require.Equal(t, "Running", string(poll().Node.Phase))
	require.Equal(t, "Running", string(poll().Node.Phase))
	c, err := a.Claim(ctx)
	require.NoError(t, err)
	require.NotNil(t, c.Job)
	require.Equal(t, 1, c.Job.Attempt)
	none, err := second.claim(ctx, "nonexistent")
	require.ErrorIs(t, err, sql.ErrNoRows)
	require.Nil(t, none)
	sealed, err := b.Claim(ctx)
	require.NoError(t, err)
	require.Nil(t, sealed.Job)
	// Simulate an interrupted worker and reclaim the same job through a different broker instance.
	_, err = db.ExecContext(ctx, `UPDATE runner_broker_jobs SET lease=clock_timestamp()-interval '1 second' WHERE id=$1`, c.Job.ID)
	require.NoError(t, err)
	current, err := b.Claim(ctx)
	require.NoError(t, err)
	require.NotNil(t, current.Job)
	require.Equal(t, c.Job.ID, current.Job.ID)
	require.Equal(t, 2, current.Job.Attempt)
	old, err := a.Heartbeat(ctx, c.Job.ID, c.Job.Token)
	require.NoError(t, err)
	require.False(t, old.Continue)
	require.NoError(t, a.Result(ctx, c.Job.ID, c.Job.Token, api.Result{Phase: api.PhaseError, Message: "discard me"}))
	require.Equal(t, "Running", string(poll().Node.Phase))
	j := current.Job
	var input bytes.Buffer
	require.NoError(t, b.DownloadArtifact(ctx, j.ID, j.Token, "source", &input))
	require.Equal(t, "hello", input.String())
	require.NoError(t, b.AppendLog(ctx, j.ID, j.Token, 0, []byte("log")))
	require.NoError(t, b.AppendLog(ctx, j.ID, j.Token, 0, []byte("log")))
	require.NoError(t, b.UploadArtifact(ctx, j.ID, j.Token, "report", strings.NewReader("report"), 6))
	result := api.Result{Phase: api.PhaseSucceeded, OutputParameters: []api.OutputParameter{{Name: "message", Value: "done"}}}
	require.NoError(t, b.Result(ctx, j.ID, j.Token, result))
	require.NoError(t, b.Result(ctx, j.ID, j.Token, result))
	out := poll()
	require.Equal(t, "Succeeded", string(out.Node.Phase))
	require.Equal(t, "done", out.Node.Outputs.Parameters[0].Value.String())
	require.Equal(t, "report", out.Node.Outputs.Artifacts[0].Raw.Data)
	var logs string
	require.NoError(t, db.QueryRowContext(ctx, `SELECT convert_from(logs,'UTF8') FROM runner_broker_jobs WHERE id=$1`, j.ID).Scan(&logs))
	require.Equal(t, "log", logs)

	// Once Argo stops renewing its interest, an otherwise valid worker
	// can neither extend the lease nor complete the step.
	cancelled := strings.ReplaceAll(payload, "workflow.remote", "workflow.cancelled")
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, PluginPath, strings.NewReader(cancelled))
	req.Header.Set("Authorization", "Bearer argo-token")
	plugin.ServeHTTP(w, req)
	require.Contains(t, w.Body.String(), "\"phase\":\"Running\"")
	abandoned, err := a.Claim(ctx)
	require.NoError(t, err)
	require.NotNil(t, abandoned.Job)
	_, err = db.ExecContext(ctx, `UPDATE runner_broker_jobs SET interest=clock_timestamp()-interval '1 second' WHERE id=$1`, abandoned.Job.ID)
	require.NoError(t, err)
	stopped, err := a.Heartbeat(ctx, abandoned.Job.ID, abandoned.Job.Token)
	require.NoError(t, err)
	require.False(t, stopped.Continue)
	require.NoError(t, first.Maintain(ctx))
	var message string
	require.NoError(t, db.QueryRowContext(ctx, `SELECT result->>'message' FROM runner_broker_jobs WHERE id=$1`, abandoned.Job.ID).Scan(&message))
	require.Equal(t, "Argo stopped polling the remote step", message)
}
