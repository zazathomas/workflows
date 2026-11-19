package environment

import (
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/argoproj/argo-workflows/v4/server/auth"
)

type metadataPage struct {
	Items    []Resource `json:"items"`
	Continue string     `json:"continue,omitempty"`
}

func (h *Handler) serveMetadata(w http.ResponseWriter, r *http.Request, namespace string) {
	q := r.URL.Query()
	kind, name := q.Get("kind"), q.Get("name")
	var resource string
	switch kind {
	case "ConfigMap":
		resource = "configmaps"
	case "Secret":
		resource = "secrets"
	default:
		writeError(w, http.StatusBadRequest, "kind must be ConfigMap or Secret")
		return
	}
	if name != "" {
		if len(validation.IsDNS1123Subdomain(name)) != 0 || q.Has("continue") {
			writeError(w, http.StatusBadRequest, "invalid detail request")
			return
		}
		kube := auth.GetKubeClient(r.Context()).CoreV1()
		if kind == "ConfigMap" {
			cm, err := kube.ConfigMaps(namespace).Get(r.Context(), name, metav1.GetOptions{})
			if err != nil {
				writeMetadataError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, configMapResource(cm))
			return
		}
		secret, err := kube.Secrets(namespace).Get(r.Context(), name, metav1.GetOptions{})
		if err != nil {
			writeMetadataError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, secretResource(secret))
		return
	}
	cursor := q.Get("continue")
	if len(cursor) > 4096 {
		writeError(w, http.StatusBadRequest, "cursor is too long")
		return
	}
	client := auth.GetMetadataClient(r.Context())
	if client == nil {
		writeError(w, http.StatusServiceUnavailable, "metadata client unavailable")
		return
	}
	list, err := client.Resource(schema.GroupVersionResource{Version: "v1", Resource: resource}).Namespace(namespace).
		List(r.Context(), metav1.ListOptions{Limit: listLimit, Continue: cursor})
	if err != nil {
		writeMetadataError(w, err)
		return
	}
	page := metadataPage{Items: make([]Resource, 0, len(list.Items)), Continue: list.Continue}
	for _, item := range list.Items {
		page.Items = append(page.Items, Resource{Kind: kind, Name: item.Name, CreatedAt: copyTime(item.CreationTimestamp)})
	}
	writeJSON(w, http.StatusOK, page)
}

func writeMetadataError(w http.ResponseWriter, err error) {
	switch {
	case apierrors.IsForbidden(err):
		writeError(w, http.StatusForbidden, "access is not permitted")
	case apierrors.IsNotFound(err):
		writeError(w, http.StatusNotFound, "resource not found")
	case apierrors.IsResourceExpired(err), apierrors.IsGone(err):
		writeError(w, http.StatusGone, "page expired; refresh to start again")
	case apierrors.IsBadRequest(err):
		writeError(w, http.StatusBadRequest, "invalid cursor")
	default:
		writeError(w, http.StatusBadGateway, "could not read environment")
	}
}
