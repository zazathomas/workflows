package runaction

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseHosts(t *testing.T) {
	hosts, err := ParseHosts(" GitHub.com,login.example.com,github.com ")
	require.NoError(t, err)
	assert.Equal(t, []string{"github.com", "login.example.com"}, hosts)

	hosts, err = ParseHosts(" ")
	require.NoError(t, err)
	assert.Empty(t, hosts)

	for _, value := range []string{"https://github.com", "*.github.com", "github.com:443", "localhost", "127.0.0.1", "github.com.", "github..com", "good.com,", "good.com\nother.com"} {
		t.Run(value, func(t *testing.T) {
			_, err := ParseHosts(value)
			require.Error(t, err)
		})
	}
}

func TestPolicyHandler(t *testing.T) {
	handler := NewPolicyHandler([]string{"github.com"})
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/run-action-policy", nil))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, `{"allowedHosts":["github.com"]}`, recorder.Body.String())
	assert.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))

	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodPost, "/api/v1/extensions/run-action-policy", nil))
	assert.Equal(t, http.StatusMethodNotAllowed, recorder.Code)
	assert.Equal(t, "GET", recorder.Header().Get("Allow"))
}
