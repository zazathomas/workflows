package apiserver

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
	"k8s.io/client-go/rest"

	"github.com/argoproj/argo-workflows/v4/config"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/server/types"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

func TestAuthenticatedHandlerRejectsMissingCredentials(t *testing.T) {
	gatekeeper, err := auth.NewGatekeeper(auth.Modes{auth.Client: true}, &types.Clients{}, nil, nil, nil, "", "", true, nil, time.Minute)
	require.NoError(t, err)

	called := false
	server := &argoServer{gatekeeper: gatekeeper}
	handler := server.authenticatedHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))

	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/parameter-options", nil))

	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	assert.False(t, called)
}

func TestActionPolicyRequiresAuthAndSupportsServerMode(t *testing.T) {
	gatekeeper, err := auth.NewGatekeeper(auth.Modes{auth.Client: true}, &types.Clients{}, nil, nil, nil, "", "", true, nil, time.Minute)
	require.NoError(t, err)
	called := false
	handler := (&argoServer{gatekeeper: gatekeeper}).authenticatedPolicyHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/run-action-policy", nil))
	assert.Equal(t, http.StatusUnauthorized, recorder.Code)
	assert.False(t, called)

	gatekeeper, err = auth.NewGatekeeper(auth.Modes{auth.Server: true}, &types.Clients{Kubernetes: fake.NewClientset()}, &rest.Config{}, nil, nil, "", "", true, nil, time.Minute)
	require.NoError(t, err)
	handler = (&argoServer{gatekeeper: gatekeeper}).authenticatedPolicyHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/run-action-policy", nil))
	assert.Equal(t, http.StatusOK, recorder.Code)
	assert.True(t, called)
}

func TestParameterOptionsRejectServerAuth(t *testing.T) {
	gatekeeper, err := auth.NewGatekeeper(auth.Modes{auth.Server: true}, &types.Clients{Kubernetes: fake.NewClientset()}, &rest.Config{}, nil, nil, "", "", true, nil, time.Minute)
	require.NoError(t, err)

	called := false
	server := &argoServer{gatekeeper: gatekeeper}
	handler := server.authenticatedHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		called = true
	}))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/parameter-options", nil))

	assert.Equal(t, http.StatusForbidden, recorder.Code)
	assert.False(t, called)
}

// loggingGatekeeper mimics the SSO path, which reads the logger from the
// request context. Missing one used to panic, and Envoy surfaced that to the
// browser as "upstream connect error ... connection termination".
type loggingGatekeeper struct {
	auth.Gatekeeper
}

func (g loggingGatekeeper) ContextWithRequest(ctx context.Context, _ any) (context.Context, error) {
	logging.RequireLoggerFromContext(ctx)
	return ctx, nil
}

func TestExtensionHandlersProvideLoggerInContext(t *testing.T) {
	for _, tt := range []struct {
		name     string
		handler  func(*argoServer, http.Handler) http.Handler
		expected int
	}{
		{name: "parameter options", handler: (*argoServer).authenticatedHandler, expected: http.StatusForbidden},
		{name: "run action policy", handler: (*argoServer).authenticatedPolicyHandler, expected: http.StatusOK},
	} {
		t.Run(tt.name, func(t *testing.T) {
			server := &argoServer{gatekeeper: loggingGatekeeper{}}
			handler := tt.handler(server, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(http.StatusOK)
			}))
			recorder := httptest.NewRecorder()

			handler.ServeHTTP(recorder, httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/api/v1/extensions/", nil))

			assert.Equal(t, tt.expected, recorder.Code)
		})
	}
}

func TestNewArgoServerIgnoresLogoutRedirectOutsideSSO(t *testing.T) {
	for _, tt := range []struct {
		name      string
		authModes auth.Modes
	}{
		{name: "client", authModes: auth.Modes{auth.Client: true}},
		{name: "server", authModes: auth.Modes{auth.Server: true}},
	} {
		t.Run(tt.name, func(t *testing.T) {
			const namespace = "argo"
			kube := fake.NewClientset(&corev1.ConfigMap{
				ObjectMeta: metav1.ObjectMeta{Name: common.ConfigMapName, Namespace: namespace},
				Data:       map[string]string{"config": "sso:\n  logoutRedirectUrl: /logged-out\n"},
			})
			server, err := NewArgoServer(logging.TestContext(t.Context()), ArgoServerOpts{
				Namespace:  namespace,
				ConfigName: common.ConfigMapName,
				Clients:    &types.Clients{Kubernetes: kube},
				AuthModes:  tt.authModes,
			})
			require.NoError(t, err)
			as := server.(*argoServer)
			assert.Empty(t, as.oAuth2Service.LogoutURL())
			assert.Empty(t, as.oAuth2Service.LogoutRedirectURL())
			assert.Empty(t, as.oAuth2Service.ClientID())
		})
	}
}

func TestNewArgoServerRejectsInvalidSSOLogoutRedirect(t *testing.T) {
	const namespace = "argo"
	kube := fake.NewClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: common.ConfigMapName, Namespace: namespace},
		Data:       map[string]string{"config": "sso:\n  logoutRedirectUrl: /logged-out\n"},
	})
	_, err := NewArgoServer(logging.TestContext(t.Context()), ArgoServerOpts{
		Namespace:  namespace,
		ConfigName: common.ConfigMapName,
		Clients:    &types.Clients{Kubernetes: kube},
		AuthModes:  auth.Modes{auth.SSO: true},
	})
	require.ErrorContains(t, err, "logout redirect URL must be an absolute HTTP(S) URL")
}

func TestValidateArtifactDriverImages(t *testing.T) {
	tests := []struct {
		name           string
		config         *config.Config
		pod            *corev1.Pod
		expectedError  bool
		expectedErrMsg string
	}{
		{
			name: "No artifact drivers configured - should skip validation",
			config: &config.Config{
				ArtifactDrivers: []config.ArtifactDriver{},
			},
			expectedError: false,
		},
		{
			name: "All artifact driver images present in pod - should pass",
			config: &config.Config{
				ArtifactDrivers: []config.ArtifactDriver{
					{
						Name:  "my-driver",
						Image: "my-driver:latest",
					},
					{
						Name:  "another-driver",
						Image: "another-driver:v1.0",
					},
				},
			},
			pod: &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod",
					Namespace: "argo",
					Labels: map[string]string{
						"app": "argo-server",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "argo-server",
							Image: "quay.io/argoproj/argocli:latest",
						},
						{
							Name:  "my-driver",
							Image: "my-driver:latest",
						},
						{
							Name:  "another-driver",
							Image: "another-driver:v1.0",
						},
					},
				},
				Status: corev1.PodStatus{
					Phase: corev1.PodRunning,
				},
			},
			expectedError: false,
		},
		{
			name: "Missing artifact driver image in pod - should fail",
			config: &config.Config{
				ArtifactDrivers: []config.ArtifactDriver{
					{
						Name:  "my-driver",
						Image: "my-driver:latest",
					},
					{
						Name:  "missing-driver",
						Image: "missing-driver:v1.0",
					},
				},
			},
			pod: &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod",
					Namespace: "argo",
					Labels: map[string]string{
						"app": "argo-server",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "argo-server",
							Image: "quay.io/argoproj/argocli:latest",
						},
						{
							Name:  "my-driver",
							Image: "my-driver:latest",
						},
					},
				},
				Status: corev1.PodStatus{
					Phase: corev1.PodRunning,
				},
			},
			expectedError:  true,
			expectedErrMsg: "Artifact driver validation failed: The following artifact driver images are not present in the server pod: [missing-driver:v1.0]",
		},
		{
			name: "Artifact driver image in regular container - should pass",
			config: &config.Config{
				ArtifactDrivers: []config.ArtifactDriver{
					{
						Name:  "sidecar-driver",
						Image: "sidecar-driver:latest",
					},
				},
			},
			pod: &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "test-pod",
					Namespace: "argo",
					Labels: map[string]string{
						"app": "argo-server",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "argo-server",
							Image: "quay.io/argoproj/argocli:latest",
						},
						{
							Name:  "sidecar-driver",
							Image: "sidecar-driver:latest",
						},
					},
				},
				Status: corev1.PodStatus{
					Phase: corev1.PodRunning,
				},
			},
			expectedError: false,
		},
		{
			name: "Test fallback to label selector when ARGO_POD_NAME not set",
			config: &config.Config{
				ArtifactDrivers: []config.ArtifactDriver{
					{
						Name:  "fallback-driver",
						Image: "fallback-driver:latest",
					},
				},
			},
			pod: &corev1.Pod{
				ObjectMeta: metav1.ObjectMeta{
					Name:      "fallback-test-pod",
					Namespace: "argo",
					Labels: map[string]string{
						"app": "argo-server",
					},
				},
				Spec: corev1.PodSpec{
					Containers: []corev1.Container{
						{
							Name:  "argo-server",
							Image: "quay.io/argoproj/argocli:latest",
						},
						{
							Name:  "fallback-driver",
							Image: "fallback-driver:latest",
						},
					},
				},
				Status: corev1.PodStatus{
					Phase: corev1.PodRunning,
				},
			},
			expectedError: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// Create fake Kubernetes client
			fakeClient := fake.NewClientset()

			// Create the argoServer instance
			as := &argoServer{
				clients: &types.Clients{
					Kubernetes: fakeClient,
				},
				namespace: "argo",
			}

			// Set up the test data
			ctx := logging.TestContext(t.Context())
			if tt.pod != nil {
				_, err := fakeClient.CoreV1().Pods("argo").Create(ctx, tt.pod, metav1.CreateOptions{})
				require.NoError(t, err)
			}

			// Set ARGO_POD_NAME environment variable for most tests, except the fallback test
			if tt.name != "Test fallback to label selector when ARGO_POD_NAME not set" {
				t.Setenv(common.EnvVarPodName, "test-pod")
			} else {
				// For the fallback test, ensure the environment variable is not set
				t.Setenv(common.EnvVarPodName, "")
			}

			// Run the validation with proper logging context
			err := as.validateArtifactDriverImages(ctx, tt.config)

			// Check results
			if tt.expectedError {
				require.Error(t, err)
				if tt.expectedErrMsg != "" {
					require.Contains(t, err.Error(), tt.expectedErrMsg)
				}
			} else {
				require.NoError(t, err)
			}
		})
	}
}
