package notify

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	authorizationv1 "k8s.io/api/authorization/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kubefake "k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

func TestTestHandlerSends(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	kube := kubefake.NewSimpleClientset()
	notificationConfigMap(t, kube, ns, map[string]string{
		"hook": `{"type": "webhook", "url": {"value": "` + server.URL + `"}}`,
	})
	// Only the dedicated test-send grant authorizes external delivery.
	kube.PrependReactor("create", "selfsubjectaccessreviews", func(action ktesting.Action) (bool, runtime.Object, error) {
		review := action.(ktesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview)
		attrs := review.Spec.ResourceAttributes
		review.Status.Allowed = attrs.Group == "platform.argoproj.io" && attrs.Resource == "notificationtests" && attrs.Verb == "send" && attrs.Namespace == ns && attrs.Name != "denied"
		return true, review, nil
	})
	c := newTestController(t, kube, []string{testHost(t, server)})
	handler := NewTestHandler(c, logging.NewTestLogger(logging.Info, logging.Text))

	req := httptest.NewRequest(http.MethodPost, TestPathPrefix+"/"+ns+"/test", strings.NewReader(`{"destination": "hook"}`))
	req.Header.Set("Content-Type", "application/json")
	recorder := httptest.NewRecorder()
	ctx := logging.WithLogger(req.Context(), logging.NewTestLogger(logging.Info, logging.Text))
	ctx = auth.WithCallerScopedCredentials(context.WithValue(ctx, auth.KubeKey, kube))
	handler.ServeHTTP(recorder, req.WithContext(ctx))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	assert.Contains(t, recorder.Body.String(), "delivered")

	// A destination the ConfigMap does not define is a 404.
	req = httptest.NewRequest(http.MethodPost, TestPathPrefix+"/"+ns+"/test", strings.NewReader(`{"destination": "missing"}`))
	req.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	ctx404 := context.WithValue(logging.WithLogger(req.Context(), logging.NewTestLogger(logging.Info, logging.Text)), auth.KubeKey, kube)
	handler.ServeHTTP(recorder, req.WithContext(auth.WithCallerScopedCredentials(ctx404)))
	assert.Equal(t, http.StatusNotFound, recorder.Code)

	for _, tc := range []struct {
		body string
		want int
	}{
		{`{"destination":"denied"}`, http.StatusForbidden},
		{`{"destination":"hook","namespace":"other"}`, http.StatusBadRequest},
		{`{"destination":"hook"} {"destination":"other"}`, http.StatusBadRequest},
	} {
		req = httptest.NewRequest(http.MethodPost, TestPathPrefix+"/"+ns+"/test", strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		recorder = httptest.NewRecorder()
		handler.ServeHTTP(recorder, req.WithContext(ctx))
		assert.Equal(t, tc.want, recorder.Code)
	}

	// A non-JSON content type is refused (CSRF).
	req = httptest.NewRequest(http.MethodPost, TestPathPrefix+"/"+ns+"/test", nil)
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusUnsupportedMediaType, recorder.Code)

	// An unknown path is a 404.
	req = httptest.NewRequest(http.MethodPost, TestPathPrefix+"/other", nil)
	req.Header.Set("Content-Type", "application/json")
	recorder = httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)
	assert.Equal(t, http.StatusNotFound, recorder.Code)
}
