package commands

import (
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/argoproj/argo-workflows/v4/pkg/runner/api"
	"github.com/argoproj/argo-workflows/v4/runner"
)

// `argo-runner rotate` replaces the stored signing key with a fresh one and
// sends the new public key to the server, signed with the old key.
func TestRotateCommandReplacesTheKey(t *testing.T) {
	var (
		gotPath   string
		gotPublic string
	)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		var req api.RotateRequest
		require.NoError(t, json.NewDecoder(r.Body).Decode(&req))
		gotPublic = req.PublicKey
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	dir := t.TempDir()
	_, oldKey, err := ed25519.GenerateKey(nil)
	require.NoError(t, err)
	require.NoError(t, runner.SaveCredentials(dir, &runner.Credentials{
		RunnerID:   "r-1",
		Pool:       "build",
		PrivateKey: oldKey,
		ServerURL:  server.URL,
	}))

	command := NewCommand()
	command.SetArgs([]string{"rotate", "--credentials-dir", dir})
	require.NoError(t, command.ExecuteContext(t.Context()))

	assert.Equal(t, api.APIPathPrefix+"/rotate", gotPath)
	creds, err := runner.LoadCredentials(dir)
	require.NoError(t, err)
	assert.NotEqual(t, []byte(oldKey), creds.PrivateKey, "the stored key is replaced")

	newKey, err := creds.Key()
	require.NoError(t, err)
	sent, err := api.DecodePublicKey(gotPublic)
	require.NoError(t, err)
	assert.Equal(t, newKey.Public().(ed25519.PublicKey), sent, "the server is told about the new key")
}
