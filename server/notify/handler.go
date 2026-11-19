package notify

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	"golang.org/x/time/rate"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

// TestPathPrefix is the HTTP prefix of the notification test-send endpoint.
const TestPathPrefix = "/api/v1/extensions/notifications"

// TestHandler serves the notification test-send endpoint.
type TestHandler struct {
	controller *Controller
	log        logging.Logger
	limit      *rate.Limiter
	slots      chan struct{}
}

// NewTestHandler creates the test-send handler.
func NewTestHandler(controller *Controller, log logging.Logger) *TestHandler {
	return &TestHandler{controller: controller, log: log, limit: rate.NewLimiter(rate.Every(time.Second), 4), slots: make(chan struct{}, 4)}
}

// TestNamespace resolves the canonical target of the test-send route.
func TestNamespace(r *http.Request) string {
	rest, ok := strings.CutPrefix(r.URL.Path, TestPathPrefix+"/")
	namespace, suffix, split := strings.Cut(rest, "/")
	if !ok || !split || suffix != "test" || len(validation.IsDNS1123Label(namespace)) != 0 {
		return ""
	}
	return namespace
}

// ServeHTTP routes POST /api/v1/extensions/notifications/{namespace}/test.
func (h *TestHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	namespace := TestNamespace(r)
	if namespace == "" || (h.controller.managedNamespace != "" && namespace != h.controller.managedNamespace) {
		http.Error(w, "unknown notification endpoint", http.StatusNotFound)
		return
	}
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	// JSON content type only (CSRF: a cross-site form post must not be able
	// to send notifications).
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	log := logging.GetLoggerFromContextOrNil(r.Context())
	if log == nil {
		log = h.log
	}
	ctx, cancel := context.WithTimeout(logging.WithLogger(r.Context(), log), 15*time.Second)
	defer cancel()
	if !auth.CanUseParameterSources(ctx) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	var body struct {
		Destination string `json:"destination"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil {
		http.Error(w, "invalid request body: "+err.Error(), http.StatusBadRequest)
		return
	}
	if !errors.Is(dec.Decode(new(json.RawMessage)), io.EOF) || len(validation.IsConfigMapKey(body.Destination)) != 0 {
		http.Error(w, "one valid destination is required", http.StatusBadRequest)
		return
	}
	allowed, err := auth.CanUseExtension(ctx, "send", "notificationtests", namespace, body.Destination)
	if err != nil {
		http.Error(w, "authorization check failed", http.StatusServiceUnavailable)
		return
	}
	if !allowed {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		w.Header().Set("Retry-After", "1")
		http.Error(w, "test sends are busy", http.StatusTooManyRequests)
		return
	}
	if !h.limit.Allow() {
		w.Header().Set("Retry-After", "1")
		http.Error(w, "test send rate limit reached", http.StatusTooManyRequests)
		return
	}
	kube := auth.GetKubeClient(ctx)
	cm, err := kube.CoreV1().ConfigMaps(namespace).Get(ctx, ConfigMapName, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		http.Error(w, "namespace has no "+ConfigMapName+" ConfigMap", http.StatusNotFound)
		return
	}
	if apierrors.IsForbidden(err) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	if err != nil {
		http.Error(w, "failed to read the notification configuration", http.StatusInternalServerError)
		return
	}
	raw, ok := cm.Data[body.Destination]
	if !ok {
		http.Error(w, "destination is not defined in the "+ConfigMapName+" ConfigMap", http.StatusNotFound)
		return
	}
	var transport Transport
	if err := json.Unmarshal([]byte(raw), &transport); err != nil {
		http.Error(w, "destination has an invalid transport", http.StatusBadRequest)
		return
	}
	if h.controller.durable {
		name, err := h.controller.enqueue(ctx, namespace, body.Destination, transport, Delivery{
			Trigger: "test",
			Subject: "argo notification test",
			Body:    "This is a test notification queued from argo-server.",
		})
		if err != nil {
			log.WithError(err).Warn(ctx, "failed to queue notification test")
			http.Error(w, "failed to queue test notification", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "queued", "record": name})
		return
	}
	outcomes := h.controller.Deliver(ctx, namespace,
		map[string]Transport{body.Destination: transport}, []string{body.Destination},
		Delivery{
			Trigger:   "test",
			Subject:   "argo-server notification test",
			Body:      "This is a test notification sent from argo-server.",
			DedupeKey: "test/" + body.Destination,
		})
	if outcome, ok := outcomes[body.Destination]; ok && outcome != "delivered" {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": outcome})
		return
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]string{"message": "delivered"})
}
