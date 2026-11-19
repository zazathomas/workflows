package environment

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

func requestWithKube(t *testing.T, url string, kube *fake.Clientset, callerScoped bool) *http.Request {
	t.Helper()
	ctx := context.WithValue(logging.TestContext(t.Context()), auth.KubeKey, kube)
	if callerScoped {
		ctx = auth.WithCallerScopedCredentials(ctx)
	}
	return httptest.NewRequestWithContext(ctx, http.MethodGet, url, nil)
}

func TestListsKeysWithoutValues(t *testing.T) {
	created := metav1.NewTime(metav1.Now().Time)
	immutable := true
	kube := fake.NewSimpleClientset(
		&corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo", CreationTimestamp: created},
			Data:       map[string]string{"regions": `["eu-west-1"]`, "teams": "platform"},
			BinaryData: map[string][]byte{"blob": []byte("abc")},
		},
		&corev1.Secret{
			ObjectMeta: metav1.ObjectMeta{Name: "registry", Namespace: "argo"},
			Type:       corev1.SecretTypeDockerConfigJson,
			Immutable:  &immutable,
			Data:       map[string][]byte{"token": []byte("super-secret-value")},
		},
		// Another namespace must not leak into the listing.
		&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "other", Namespace: "default"}, Data: map[string][]byte{"key": []byte("value")}},
	)
	route := requestWithKube(t, "/?namespace=argo", kube, true)
	recorder := httptest.NewRecorder()

	NewHandler().ServeHTTP(recorder, route)

	require.Equal(t, http.StatusOK, recorder.Code)
	body := recorder.Body.String()
	assert.NotContains(t, body, "super-secret-value")
	assert.NotContains(t, body, "eu-west-1")
	assert.NotContains(t, body, "platform")
	var response ListResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Equal(t, "argo", response.Namespace)
	assert.Empty(t, response.Errors)
	require.Len(t, response.ConfigMaps, 1)
	assert.Equal(t, []Key{{Name: "blob", Size: 3}, {Name: "regions", Size: 13}, {Name: "teams", Size: 8}}, response.ConfigMaps[0].Keys)
	require.NotNil(t, response.ConfigMaps[0].CreatedAt)
	require.Len(t, response.Secrets, 1)
	assert.Equal(t, "Secret", response.Secrets[0].Kind)
	assert.Equal(t, string(corev1.SecretTypeDockerConfigJson), response.Secrets[0].Type)
	assert.True(t, response.Secrets[0].Immutable)
	assert.Equal(t, []Key{{Name: "token", Size: 18}}, response.Secrets[0].Keys)
}

func TestListsOnlyTheRequestedNamespace(t *testing.T) {
	kube := fake.NewSimpleClientset(&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"}})
	var namespaces []string
	kube.PrependReactor("list", "configmaps", func(action k8stesting.Action) (bool, runtime.Object, error) {
		namespaces = append(namespaces, action.GetNamespace())
		return false, nil, nil
	})
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, requestWithKube(t, "/?namespace=argo", kube, true))
	require.Equal(t, http.StatusOK, recorder.Code)
	assert.Equal(t, []string{"argo"}, namespaces)
}

func TestPartialPermissions(t *testing.T) {
	kube := fake.NewSimpleClientset(&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"}})
	kube.PrependReactor("list", "secrets", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(corev1.Resource("secrets"), "", nil)
	})
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, requestWithKube(t, "/?namespace=argo", kube, true))

	require.Equal(t, http.StatusOK, recorder.Code)
	var response ListResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	assert.Len(t, response.ConfigMaps, 1)
	assert.Empty(t, response.Secrets)
	assert.Equal(t, []string{"reading Secrets is not permitted"}, response.Errors)
}

func TestFailsClosed(t *testing.T) {
	forbiddenClient := fake.NewSimpleClientset()
	for _, kind := range []string{"configmaps", "secrets"} {
		forbiddenClient.PrependReactor("list", kind, func(k8stesting.Action) (bool, runtime.Object, error) {
			return true, nil, apierrors.NewForbidden(corev1.Resource(kind), "", nil)
		})
	}
	tests := []struct {
		name   string
		route  func(t *testing.T) *http.Request
		status int
	}{
		{
			name: "server auth mode is refused",
			route: func(t *testing.T) *http.Request {
				return requestWithKube(t, "/?namespace=argo", fake.NewSimpleClientset(), false)
			},
			status: http.StatusForbidden,
		},
		{
			name: "namespace is required",
			route: func(t *testing.T) *http.Request {
				return requestWithKube(t, "/", fake.NewSimpleClientset(), true)
			},
			status: http.StatusBadRequest,
		},
		{
			name: "invalid namespace",
			route: func(t *testing.T) *http.Request {
				return requestWithKube(t, "/?namespace=../other", fake.NewSimpleClientset(), true)
			},
			status: http.StatusBadRequest,
		},
		{
			name: "both kinds forbidden",
			route: func(t *testing.T) *http.Request {
				return requestWithKube(t, "/?namespace=argo", forbiddenClient, true)
			},
			status: http.StatusForbidden,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			recorder := httptest.NewRecorder()
			NewHandler().ServeHTTP(recorder, tt.route(t))
			assert.Equal(t, tt.status, recorder.Code)
			assert.NotContains(t, recorder.Body.String(), "server-token")
		})
	}
}

func TestAPIErrorsFailTheRequest(t *testing.T) {
	kube := fake.NewSimpleClientset()
	kube.PrependReactor("list", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewInternalError(assert.AnError)
	})
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, requestWithKube(t, "/?namespace=argo", kube, true))
	assert.Equal(t, http.StatusBadGateway, recorder.Code)
}

func TestReportsTruncation(t *testing.T) {
	kube := fake.NewSimpleClientset()
	kube.PrependReactor("list", "configmaps", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, &corev1.ConfigMapList{ListMeta: metav1.ListMeta{Continue: "next"}}, nil
	})
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, requestWithKube(t, "/?namespace=argo", kube, true))

	require.Equal(t, http.StatusOK, recorder.Code)
	var response ListResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &response))
	assert.True(t, response.ConfigMapsTruncated)
	assert.False(t, response.SecretsTruncated)
}

func TestOnlyGET(t *testing.T) {
	route := requestWithKube(t, "/?namespace=argo", fake.NewSimpleClientset(), true)
	route.Method = http.MethodPost
	recorder := httptest.NewRecorder()
	NewHandler().ServeHTTP(recorder, route)
	assert.Equal(t, http.StatusMethodNotAllowed, recorder.Code)
}
