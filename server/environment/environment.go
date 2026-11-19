// Package environment implements the read-only Environment viewer used by the
// UI to show the ConfigMaps and Secrets a namespace holds. Values never leave
// the server: the response carries key names and sizes only, because the Argo
// API has no other way to enumerate these resources and a browser-side reveal
// would hand secret data to anyone who can open the page.
package environment

import (
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

const (
	// listLimit bounds one namespace's listing; the response reports when the
	// API server had more objects so the UI can say so instead of hiding them.
	listLimit = 32
	// listTimeout keeps a slow cluster from holding the request open.
	listTimeout = 10 * time.Second
)

// Key is one entry of a ConfigMap or Secret. Only the name and the byte size
// are exposed; the value is never serialized.
type Key struct {
	Name string `json:"name"`
	Size int    `json:"size"`
}

// Resource describes one ConfigMap or Secret.
type Resource struct {
	Kind      string       `json:"kind"`
	Name      string       `json:"name"`
	Keys      []Key        `json:"keys"`
	Type      string       `json:"type,omitempty"`
	Immutable bool         `json:"immutable,omitempty"`
	CreatedAt *metav1.Time `json:"createdAt,omitempty"`
}

// ListResponse is the body of a successful listing.
type ListResponse struct {
	Namespace           string     `json:"namespace"`
	ConfigMaps          []Resource `json:"configMaps"`
	Secrets             []Resource `json:"secrets"`
	Errors              []string   `json:"errors,omitempty"`
	ConfigMapsTruncated bool       `json:"configMapsTruncated,omitempty"`
	SecretsTruncated    bool       `json:"secretsTruncated,omitempty"`
}

// Handler serves GET /api/v1/extensions/environment?namespace=NAME.
// It uses the caller's Kubernetes identity, so RBAC on configmaps and secrets
// decides what is listed. The route is mounted through the server's
// caller-scoped extension handler, which also refuses server auth mode.
type Handler struct {
	slots chan struct{}
}

func NewHandler() *Handler {
	return &Handler{slots: make(chan struct{}, 2)}
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "only GET is supported")
		return
	}
	// Defence in depth: never list with the server's service account.
	if !auth.CanUseParameterSources(r.Context()) {
		writeError(w, http.StatusForbidden, "the environment viewer requires client auth or SSO with RBAC")
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	namespace := r.URL.Query().Get("namespace")
	if namespace == "" {
		writeError(w, http.StatusBadRequest, "namespace is required")
		return
	}
	if errs := validation.IsDNS1123Label(namespace); len(errs) > 0 {
		writeError(w, http.StatusBadRequest, "invalid namespace")
		return
	}

	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		writeError(w, http.StatusTooManyRequests, "environment viewer is busy")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), listTimeout)
	defer cancel()
	if r.URL.Query().Get("view") == "metadata" {
		h.serveMetadata(w, r.WithContext(ctx), namespace)
		return
	}
	kube := auth.GetKubeClient(ctx)
	log := logging.RequireLoggerFromContext(ctx)

	configMaps, configMapErr := kube.CoreV1().ConfigMaps(namespace).List(ctx, metav1.ListOptions{Limit: listLimit})
	if configMapErr != nil && !apierrors.IsForbidden(configMapErr) {
		log.WithError(configMapErr).Error(ctx, "failed to list ConfigMaps")
		writeError(w, http.StatusBadGateway, "could not read ConfigMaps")
		return
	}
	secrets, secretErr := kube.CoreV1().Secrets(namespace).List(ctx, metav1.ListOptions{Limit: listLimit})
	if secretErr != nil && !apierrors.IsForbidden(secretErr) {
		log.WithError(secretErr).Error(ctx, "failed to list Secrets")
		writeError(w, http.StatusBadGateway, "could not read Secrets")
		return
	}
	if apierrors.IsForbidden(configMapErr) && apierrors.IsForbidden(secretErr) {
		writeError(w, http.StatusForbidden, "listing ConfigMaps and Secrets is not permitted in this namespace")
		return
	}

	response := ListResponse{Namespace: namespace}
	if apierrors.IsForbidden(configMapErr) {
		response.Errors = append(response.Errors, "reading ConfigMaps is not permitted")
	} else {
		for i := range configMaps.Items {
			response.ConfigMaps = append(response.ConfigMaps, configMapResource(&configMaps.Items[i]))
		}
		response.ConfigMapsTruncated = configMaps.Continue != ""
		sort.Slice(response.ConfigMaps, func(i, j int) bool { return response.ConfigMaps[i].Name < response.ConfigMaps[j].Name })
	}
	if apierrors.IsForbidden(secretErr) {
		response.Errors = append(response.Errors, "reading Secrets is not permitted")
	} else {
		for i := range secrets.Items {
			response.Secrets = append(response.Secrets, secretResource(&secrets.Items[i]))
		}
		response.SecretsTruncated = secrets.Continue != ""
		sort.Slice(response.Secrets, func(i, j int) bool { return response.Secrets[i].Name < response.Secrets[j].Name })
	}
	writeJSON(w, http.StatusOK, response)
}

func configMapResource(configMap *corev1.ConfigMap) Resource {
	keys := make([]Key, 0, len(configMap.Data)+len(configMap.BinaryData))
	for name, value := range configMap.Data {
		keys = append(keys, Key{Name: name, Size: len(value)})
	}
	for name, value := range configMap.BinaryData {
		keys = append(keys, Key{Name: name, Size: len(value)})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Name < keys[j].Name })
	return Resource{
		Kind:      "ConfigMap",
		Name:      configMap.Name,
		Keys:      keys,
		Immutable: configMap.Immutable != nil && *configMap.Immutable,
		CreatedAt: copyTime(configMap.CreationTimestamp),
	}
}

func secretResource(secret *corev1.Secret) Resource {
	keys := make([]Key, 0, len(secret.Data))
	for name, value := range secret.Data {
		keys = append(keys, Key{Name: name, Size: len(value)})
	}
	sort.Slice(keys, func(i, j int) bool { return keys[i].Name < keys[j].Name })
	return Resource{
		Kind:      "Secret",
		Name:      secret.Name,
		Keys:      keys,
		Type:      string(secret.Type),
		Immutable: secret.Immutable != nil && *secret.Immutable,
		CreatedAt: copyTime(secret.CreationTimestamp),
	}
}

func copyTime(t metav1.Time) *metav1.Time {
	if t.IsZero() {
		return nil
	}
	return t.DeepCopy()
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"message": message})
}
