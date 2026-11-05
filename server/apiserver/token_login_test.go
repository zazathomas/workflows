package apiserver

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"
	k8stesting "k8s.io/client-go/testing"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/server/types"
)

func TestTokenLoginValidatesTokenAndOrigin(t *testing.T) {
	allowed := true
	kube := fake.NewClientset()
	kube.PrependReactor("create", "selfsubjectreviews", func(k8stesting.Action) (bool, runtime.Object, error) {
		if !allowed {
			return true, nil, errors.New("invalid token")
		}
		return true, nil, nil
	})
	client := func(string, *rest.Config) (*rest.Config, *types.Clients, error) {
		return &rest.Config{}, &types.Clients{Kubernetes: kube}, nil
	}
	gatekeeper, err := auth.NewGatekeeper(auth.Modes{auth.Client: true}, &types.Clients{}, &rest.Config{}, nil, client, "", "", true, nil, time.Minute)
	require.NoError(t, err)
	server := &argoServer{gatekeeper: gatekeeper, baseHRef: "/argo/"}
	for _, tt := range []struct {
		name, method, origin, token string
		status                      int
	}{
		{"valid", http.MethodPost, "https://example.com", "valid", http.StatusNoContent},
		{"invalid", http.MethodPost, "https://example.com", "invalid", http.StatusUnauthorized},
		{"cross origin", http.MethodPost, "https://attacker.example.com", "valid", http.StatusForbidden},
		{"no origin", http.MethodPost, "", "valid", http.StatusForbidden},
		{"wrong method", http.MethodGet, "https://example.com", "valid", http.StatusMethodNotAllowed},
	} {
		t.Run(tt.name, func(t *testing.T) {
			allowed = tt.token != "invalid"
			r := httptest.NewRequestWithContext(t.Context(), tt.method, "https://example.com/auth/token", strings.NewReader(tt.token))
			r.Header.Set("Origin", tt.origin)
			w := httptest.NewRecorder()
			server.tokenLoginHandler(w, r)
			assert.Equal(t, tt.status, w.Code)
			if tt.status == http.StatusNoContent {
				cookies := w.Result().Cookies()
				require.Len(t, cookies, 1)
				assert.Equal(t, "Bearer valid", cookies[0].Value)
				assert.Equal(t, "/argo/", cookies[0].Path)
				assert.True(t, cookies[0].HttpOnly)
				assert.True(t, cookies[0].Secure)
			}
		})
	}
}
