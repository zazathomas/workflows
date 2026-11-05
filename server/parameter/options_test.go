package parameter

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes/fake"
	k8stesting "k8s.io/client-go/testing"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wffake "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned/fake"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

func TestParseHostsRejectsEntriesThatCannotMatch(t *testing.T) {
	hosts, err := ParseHosts(" Gist.GitHubUserContent.com , example.org,EXAMPLE.org ")
	require.NoError(t, err)
	assert.Equal(t, []string{"example.org", "gist.githubusercontent.com"}, hosts)

	for _, value := range []string{"https://example.com", "*.example.com", "example.com:443", "127.0.0.1", "example", "user@example.com", "example.org,"} {
		_, err := ParseHosts(value)
		assert.Error(t, err, value)
	}
}

func TestMapOptionsLimitsSize(t *testing.T) {
	tooMany := make([]any, maxOptions+1)
	for i := range tooMany {
		tooMany[i] = "value"
	}
	_, err := mapOptions(tooMany, "", "", "")
	require.ErrorContains(t, err, "limit is")

	long := strings.Repeat("a", maxOptionTextSize+1)
	_, err = mapOptions([]any{long}, "", "", "")
	require.ErrorContains(t, err, "at most")
}

func TestMapOptions(t *testing.T) {
	document := map[string]any{
		"repositories": []any{
			map[string]any{"name": "argo-workflows", "full_name": "argoproj/argo-workflows"},
			map[string]any{"name": "argo-cd", "full_name": "argoproj/argo-cd"},
		},
	}

	items, err := mapOptions(document, "repositories", "name", "full_name")

	require.NoError(t, err)
	assert.Equal(t, []Option{
		{Label: "argo-workflows", Value: "argoproj/argo-workflows"},
		{Label: "argo-cd", Value: "argoproj/argo-cd"},
	}, items)
}

func TestMapOptionsStringArray(t *testing.T) {
	items, err := mapOptions([]any{"main", "release"}, "", "", "")

	require.NoError(t, err)
	assert.Equal(t, []Option{{Label: "main", Value: "main"}, {Label: "release", Value: "release"}}, items)
}

func TestSecretHeaderUsesAuthenticatedKubernetesClient(t *testing.T) {
	userClient := fake.NewSimpleClientset(&corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"},
		Data:       map[string][]byte{"token": []byte("user-token")},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "https://catalog.example.com?secretName=catalog&secretNamespace=argo&secretKey=token&header=Authorization", nil)
	require.NoError(t, err)
	request = request.WithContext(context.WithValue(request.Context(), auth.KubeKey, userClient))

	require.NoError(t, handler.addSecretHeader(request, request))
	assert.Equal(t, "user-token", request.Header.Get("Authorization"))
}

func TestSecretHeaderRequiresAuthenticatedClient(t *testing.T) {
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?secretName=catalog&secretNamespace=argo&secretKey=token&header=Authorization", nil)
	err := handler.addSecretHeader(request, request)
	require.ErrorContains(t, err, "authenticated Kubernetes client")
	assert.Empty(t, request.Header.Get("Authorization"))
}

func TestSecretHeaderReturnsAuthenticatedClientRBACError(t *testing.T) {
	userClient := fake.NewSimpleClientset()
	userClient.PrependReactor("get", "secrets", func(action k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, apierrors.NewForbidden(corev1.Resource("secrets"), "catalog", nil)
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	request, err := http.NewRequestWithContext(t.Context(), http.MethodGet, "https://catalog.example.com?secretName=catalog&secretNamespace=argo&secretKey=token&header=Authorization", nil)
	require.NoError(t, err)
	request = request.WithContext(context.WithValue(logging.TestContext(t.Context()), auth.KubeKey, userClient))

	err = handler.addSecretHeader(request, request)
	require.Error(t, err)
	assert.EqualError(t, err, "reading the parameter source secret is not permitted")
}

func TestConfigMapOptionsUseAuthenticatedClient(t *testing.T) {
	userClient := fake.NewSimpleClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"},
		Data:       map[string]string{"environments": `{"items":[{"name":"Staging","id":"staging"},{"name":"Production","id":"production"}]}`},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?configMapName=catalog&configMapKey=environments&namespace=argo&itemsPath=items&labelPath=name&valuePath=id", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.KubeKey, userClient))
	recorder := httptest.NewRecorder()

	handler.serveConfigMap(recorder, request, "catalog")

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, `{"items":[{"label":"Staging","value":"staging"},{"label":"Production","value":"production"}]}`, recorder.Body.String())
}

func TestConfigMapOptionsReadFromExplicitNamespace(t *testing.T) {
	userClient := fake.NewSimpleClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "shared"},
		Data:       map[string]string{"regions": `["eu-west-1"]`},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?configMapName=catalog&configMapKey=regions&configMapNamespace=shared&namespace=argo", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.KubeKey, userClient))
	recorder := httptest.NewRecorder()

	handler.serveConfigMap(recorder, request, "catalog")

	require.Equal(t, http.StatusOK, recorder.Code)
	assert.JSONEq(t, `{"items":[{"label":"eu-west-1","value":"eu-west-1"}]}`, recorder.Body.String())
}

func TestConfigMapOptionsFailClosed(t *testing.T) {
	tests := []struct {
		name   string
		query  string
		client *fake.Clientset
		status int
	}{
		{name: "requires namespace and key", query: "configMapName=catalog", status: http.StatusBadRequest},
		{name: "missing ConfigMap", query: "configMapName=missing&configMapKey=data&namespace=argo", client: fake.NewSimpleClientset(), status: http.StatusNotFound},
		{name: "missing key", query: "configMapName=catalog&configMapKey=missing&namespace=argo", client: fake.NewSimpleClientset(&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"}, Data: map[string]string{"data": "[]"}}), status: http.StatusNotFound},
		{name: "both sources", query: "url=https%3A%2F%2Fexample.com&configMapName=catalog&configMapKey=data&namespace=argo", status: http.StatusForbidden},
		{name: "neither source", query: "namespace=argo", status: http.StatusForbidden},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			client := tt.client
			if client == nil {
				client = fake.NewSimpleClientset()
			}
			handler := NewOptionsHandler(OptionsHandlerConfig{})
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?"+tt.query, nil)
			request = request.WithContext(context.WithValue(request.Context(), auth.KubeKey, client))
			recorder := httptest.NewRecorder()
			if tt.name == "both sources" || tt.name == "neither source" {
				handler.ServeHTTP(recorder, request)
			} else {
				handler.serveConfigMap(recorder, request, request.URL.Query().Get("configMapName"))
			}
			assert.Equal(t, tt.status, recorder.Code)
			assert.NotContains(t, recorder.Body.String(), "server-token")
		})
	}
}

func TestParameterSourceRequiresReadableTemplateAndExactAnnotation(t *testing.T) {
	workflowClient := wffake.NewClientset(&wfv1.WorkflowTemplate{
		ObjectMeta: metav1.ObjectMeta{
			Name: "job", Namespace: "argo",
			Annotations: map[string]string{annotationKey: `{"region":{"configMap":{"name":"catalog","key":"regions"}}}`},
		},
		Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{{Name: "region"}}}},
	})
	kube := fake.NewClientset(&corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: "catalog", Namespace: "argo"}, Data: map[string]string{"regions": `["eu-west-1"]`},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{})
	base := "/?configMapName=catalog&configMapKey=regions&namespace=argo&templateKind=WorkflowTemplate&templateName=job&parameterName=region"
	for _, tt := range []struct {
		name, query string
		status      int
	}{
		{"declared source", base, http.StatusOK},
		{"different key", strings.Replace(base, "configMapKey=regions", "configMapKey=secrets", 1), http.StatusForbidden},
		{"different name", strings.Replace(base, "configMapName=catalog", "configMapName=other", 1), http.StatusForbidden},
		{"missing template", "/?configMapName=catalog&configMapKey=regions&namespace=argo&templateKind=WorkflowTemplate&templateName=missing&parameterName=region", http.StatusForbidden},
		{"different parameter", "/?configMapName=catalog&configMapKey=regions&namespace=argo&templateKind=WorkflowTemplate&templateName=job&parameterName=other", http.StatusForbidden},
	} {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, tt.query, nil)
			request = request.WithContext(context.WithValue(context.WithValue(request.Context(), auth.WfKey, workflowClient), auth.KubeKey, kube))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			assert.Equal(t, tt.status, recorder.Code)
		})
	}
}

func TestURLSourceCannotChangeTargetOrSecretNamespace(t *testing.T) {
	workflowClient := wffake.NewClientset(&wfv1.WorkflowTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "job", Namespace: "argo", Annotations: map[string]string{
			annotationKey: `{"region":{"url":"https://catalog.example.com/{{team}}","secret":{"name":"token","key":"key","header":"X-API-Key"}}`,
		}},
		Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{{Name: "region"}}}},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{AllowedHosts: []string{"catalog.example.com", "evil.example.com"}})
	base := "/?namespace=argo&templateKind=WorkflowTemplate&templateName=job&parameterName=region&parameters=%7B%22team%22%3A%22my-team%22%7D&secretName=token&secretNamespace=argo&secretKey=key&header=X-API-Key"
	for _, tt := range []struct{ name, query string }{
		{"tampered URL", base + "&url=https%3A%2F%2Fevil.example.com"},
		{"tampered header", strings.Replace(base, "header=X-API-Key", "header=Authorization", 1)},
		{"cross-namespace secret", strings.Replace(base, "secretNamespace=argo", "secretNamespace=other", 1)},
		{"tampered parameter URL", base + "&url=https%3A%2F%2Fcatalog.example.com%2Fother-team"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, tt.query, nil)
			request = request.WithContext(context.WithValue(request.Context(), auth.WfKey, workflowClient))
			require.Error(t, handler.authorizeSource(request))
		})
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func TestOptionsHandlerFetchesDeclaredURLOnly(t *testing.T) {
	workflowClient := wffake.NewClientset(&wfv1.WorkflowTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "job", Namespace: "argo", Annotations: map[string]string{
			annotationKey: `{"region":{"url":"https://catalog.example.com/{{team}}","itemsPath":"items","labelPath":"name","valuePath":"id"}}`,
		}},
		Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{{Name: "region"}}}},
	})
	base := "/?namespace=argo&templateKind=WorkflowTemplate&templateName=job&parameterName=region&parameters=%7B%22team%22%3A%22my-team%22%7D&itemsPath=items&labelPath=name&valuePath=id"
	for _, tt := range []struct {
		name, body                     string
		upstreamStatus, expectedStatus int
	}{
		{"success", `{"items":[{"name":"Team","id":"my-team"}]}`, http.StatusOK, http.StatusOK},
		{"invalid JSON", "not JSON", http.StatusOK, http.StatusBadGateway},
		{"upstream error", "[]", http.StatusInternalServerError, http.StatusBadGateway},
		{"oversized response", strings.Repeat("x", maxResponseSize+1), http.StatusOK, http.StatusBadGateway},
	} {
		t.Run(tt.name, func(t *testing.T) {
			handler := NewOptionsHandler(OptionsHandlerConfig{AllowedHosts: []string{"catalog.example.com"}})
			handler.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
				assert.Equal(t, "catalog.example.com", request.URL.Hostname())
				assert.Equal(t, "/my-team", request.URL.Path)
				return &http.Response{StatusCode: tt.upstreamStatus, Body: io.NopCloser(strings.NewReader(tt.body)), Header: http.Header{}}, nil
			})
			request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, base, nil)
			request = request.WithContext(context.WithValue(request.Context(), auth.WfKey, workflowClient))
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			assert.Equal(t, tt.expectedStatus, recorder.Code)
			if tt.expectedStatus == http.StatusOK {
				assert.JSONEq(t, `{"items":[{"label":"Team","value":"my-team"}]}`, recorder.Body.String())
			}
		})
	}
}

func TestIdentityRateLimitAndConcurrentFetchCap(t *testing.T) {
	handler := NewOptionsHandler(OptionsHandlerConfig{AllowedHosts: []string{"catalog.example.com"}})
	alice := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	alice.Header.Set("Authorization", "Bearer alice")
	bob := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/", nil)
	bob.Header.Set("Authorization", "Bearer bob")
	for range 10 {
		assert.True(t, handler.allowIdentity(alice))
	}
	assert.False(t, handler.allowIdentity(alice))
	assert.True(t, handler.allowIdentity(bob))

	workflowClient := wffake.NewClientset(&wfv1.WorkflowTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "job", Namespace: "argo", Annotations: map[string]string{annotationKey: `{"region":{"url":"https://catalog.example.com/regions"}}`}},
		Spec:       wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{{Name: "region"}}}},
	})
	for range maxConcurrentFetches {
		handler.fetchSlots <- struct{}{}
	}
	request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?namespace=argo&templateKind=WorkflowTemplate&templateName=job&parameterName=region&parameters=%7B%7D", nil)
	request = request.WithContext(context.WithValue(request.Context(), auth.WfKey, workflowClient))
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	assert.Equal(t, http.StatusTooManyRequests, recorder.Code)
}

func TestURLSourceEncodesSpecialParameterOnServer(t *testing.T) {
	workflowClient := wffake.NewClientset(&wfv1.WorkflowTemplate{
		ObjectMeta: metav1.ObjectMeta{Name: "job", Namespace: "argo", Annotations: map[string]string{
			annotationKey: `{"region":{"url":"https://catalog.example.com/team/{{team}}"}}`,
		}},
		Spec: wfv1.WorkflowSpec{Arguments: wfv1.Arguments{Parameters: []wfv1.Parameter{{Name: "region"}}}},
	})
	handler := NewOptionsHandler(OptionsHandlerConfig{AllowedHosts: []string{"catalog.example.com"}})
	calls := 0
	handler.client.Transport = roundTripFunc(func(request *http.Request) (*http.Response, error) {
		calls++
		assert.Equal(t, "/team/team%20%28east%29", request.URL.EscapedPath())
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`[]`)), Header: http.Header{}}, nil
	})
	query := url.Values{"namespace": {"argo"}, "templateKind": {"WorkflowTemplate"}, "templateName": {"job"}, "parameterName": {"region"}, "parameters": {`{"team":"team (east)"}`}}
	for i := 0; i < 2; i++ {
		request := httptest.NewRequestWithContext(t.Context(), http.MethodGet, "/?"+query.Encode(), nil)
		request = request.WithContext(context.WithValue(request.Context(), auth.WfKey, workflowClient))
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		assert.Equal(t, http.StatusOK, recorder.Code)
	}
	assert.Equal(t, 1, calls, "the same template version and URL should be cached")
}

func TestBlockedNetworks(t *testing.T) {
	for _, address := range []string{"0.1.2.3", "240.0.0.1", "64:ff9b::a00:1", "127.0.0.1"} {
		assert.True(t, isPrivateIP(net.ParseIP(address)), address)
	}
	assert.False(t, isPrivateIP(net.ParseIP("8.8.8.8")))
}

func TestValidateURL(t *testing.T) {
	allowed := map[string]struct{}{"api.github.com": {}, "127.0.0.1": {}, "100.64.0.1": {}, "198.18.0.1": {}}

	tests := []struct {
		name      string
		sourceURL string
		wantError string
	}{
		{name: "non HTTPS", sourceURL: "http://api.github.com/repos", wantError: "must use HTTPS"},
		{name: "not allowlisted", sourceURL: "https://example.com/repos", wantError: "not allowlisted"},
		{name: "private IP", sourceURL: "https://127.0.0.1/repos", wantError: "private network"},
		{name: "shared network", sourceURL: "https://100.64.0.1/repos", wantError: "private network"},
		{name: "benchmark network", sourceURL: "https://198.18.0.1/repos", wantError: "private network"},
		{name: "embedded password", sourceURL: "https://user:password@api.github.com/repos", wantError: "cannot embed credentials"},
		{name: "custom port", sourceURL: "https://api.github.com:8443/repos", wantError: "nonstandard port"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sourceURL, err := url.Parse(tt.sourceURL)
			require.NoError(t, err)
			err = validateURL(sourceURL, allowed)
			require.Error(t, err)
			assert.Contains(t, err.Error(), tt.wantError)
		})
	}
}
