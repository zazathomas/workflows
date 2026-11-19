// Package approvals authorizes decisions for suspended Workflow nodes and
// reconciles immutable, namespace-scoped Kubernetes decision records.
package approvals

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strings"
	"time"

	authenticationv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"
	"k8s.io/client-go/kubernetes"

	"github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	authtypes "github.com/argoproj/argo-workflows/v4/server/auth/types"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

const PathPrefix = "/api/v1/extensions/approvals"

const (
	tick   = 30 * time.Second
	resync = time.Minute
)

// Decision contains the stable, authenticated actor separately from its display name.
type Decision struct {
	Decision string `json:"decision"`
	Actor    string `json:"actor"`
	Approver string `json:"approver"`
	Comment  string `json:"comment,omitempty"`
	At       string `json:"at"`
}

type actor struct {
	id, display string
	claims      *authtypes.Claims
}

type Handler struct {
	reconciler
	identity  func(context.Context) (actor, error)
	log       logging.Logger
	nowFunc   func() time.Time
	namespace string
	async     bool
}

func NewHandler(wf versioned.Interface, kube kubernetes.Interface, hydrator hydrator.Interface, log logging.Logger) *Handler {
	return &Handler{reconciler: reconciler{wf: wf, kube: kube, hydrator: hydrator}, identity: verifiedActor, log: log, nowFunc: time.Now}
}

func (h *Handler) WithScope(namespace string, instance instanceid.Service) *Handler {
	h.namespace, h.instance = namespace, instance
	return h
}

// WithWorker delegates all workflow mutations to the separate reconciler.
func (h *Handler) WithWorker() *Handler {
	h.async = true
	return h
}

type decisionRequestBody struct {
	Decision    string `json:"decision"`
	Comment     string `json:"comment"`
	WorkflowUID string `json:"workflowUID"`
	StartedAt   string `json:"startedAt"`
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "only POST is supported", http.StatusMethodNotAllowed)
		return
	}
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		http.Error(w, "content type must be application/json", http.StatusUnsupportedMediaType)
		return
	}
	if !auth.CanUseParameterSources(r.Context()) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	namespace, workflow, nodeID, ok := splitApprovalPath(r.URL.Path)
	if !ok || (h.namespace != "" && namespace != h.namespace) {
		http.NotFound(w, r)
		return
	}
	var body decisionRequestBody
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&body); err != nil || !errors.Is(dec.Decode(new(json.RawMessage)), io.EOF) {
		http.Error(w, "expected one valid decision", http.StatusBadRequest)
		return
	}
	startedAt, err := time.Parse(time.RFC3339Nano, body.StartedAt)
	if err != nil || body.WorkflowUID == "" || len(body.Comment) > 8<<10 || (body.Decision != "approve" && body.Decision != "reject") {
		http.Error(w, "expected workflowUID, startedAt, an approve or reject decision, and an optional comment of at most 8 KiB", http.StatusBadRequest)
		return
	}
	log := logging.GetLoggerFromContextOrNil(r.Context())
	if log == nil {
		log = h.log
	}
	ctx, cancel := context.WithTimeout(logging.WithLogger(r.Context(), log), 15*time.Second)
	defer cancel()
	err = h.decide(ctx, namespace, workflow, nodeID, body, startedAt)
	switch {
	case err == nil:
		w.WriteHeader(http.StatusNoContent)
	case errors.Is(err, errPending):
		w.WriteHeader(http.StatusAccepted)
	case errors.Is(err, errNotFound):
		http.NotFound(w, r)
	case errors.Is(err, errForbidden):
		http.Error(w, "forbidden", http.StatusForbidden)
	case errors.Is(err, errConflict):
		http.Error(w, "the gate attempt changed, expired, or already has a decision", http.StatusConflict)
	default:
		log.WithError(err).Warn(ctx, "approval failed")
		http.Error(w, "approval failed", http.StatusInternalServerError)
	}
}

// Namespace returns the target namespace that must be used for SSO delegation.
func Namespace(r *http.Request) string {
	namespace, _, _, _ := splitApprovalPath(r.URL.Path)
	return namespace
}

func splitApprovalPath(path string) (namespace, workflow, nodeID string, ok bool) {
	rest, found := strings.CutPrefix(path, PathPrefix+"/")
	parts := strings.Split(rest, "/")
	if !found || len(parts) != 3 || len(validation.IsDNS1123Label(parts[0])) != 0 || len(validation.IsDNS1123Subdomain(parts[1])) != 0 || parts[2] == "" {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

var (
	errNotFound  = errors.New("not found")
	errForbidden = errors.New("forbidden")
	errConflict  = errors.New("conflict")
	errPending   = errors.New("decision pending")
)

func (h *Handler) decide(ctx context.Context, namespace, workflow, nodeID string, body decisionRequestBody, startedAt time.Time) error {
	allowed, err := auth.CanUseExtension(ctx, "decide", "workflowapprovals", namespace, workflow)
	if err != nil {
		return fmt.Errorf("authorization check failed: %w", err)
	}
	if !allowed {
		return errForbidden
	}
	caller, err := h.identity(ctx)
	if err != nil {
		return err
	}
	wf, err := h.load(ctx, namespace, workflow)
	if err != nil {
		return err
	}
	node, err := activeGate(wf, nodeID)
	if err != nil {
		return err
	}
	gate := gateOf(wf, nodeID, node)
	if gate.UID != body.WorkflowUID || !node.StartedAt.Time.Equal(startedAt) {
		return errConflict
	}
	if !matchesApprover(caller.claims, gate.Policy.Approvers) {
		return errForbidden
	}
	now := h.nowFunc().UTC()
	if expiry, _ := time.ParseDuration(strings.TrimSpace(gate.Policy.Expiry)); body.Decision == "approve" && expiry > 0 && !now.Before(node.StartedAt.Add(expiry)) {
		return errConflict
	}
	item := record{Gate: gate, Decision: Decision{Decision: body.Decision, Actor: caller.id, Approver: caller.display, At: now.Format(time.RFC3339Nano), Comment: body.Comment}}
	cm, err := h.create(ctx, namespace, item)
	if err != nil {
		return err
	}
	if h.async {
		return errPending
	}
	if err := h.apply(ctx, cm); errors.Is(err, errConflict) {
		return err
	} else if err != nil {
		h.log.WithError(err).WithField("record", cm.Name).Warn(ctx, "decision recorded; reconciliation pending")
		return errPending
	}
	return nil
}

func matchesApprover(claims *authtypes.Claims, scoping string) bool {
	if strings.TrimSpace(scoping) == "" {
		return true
	}
	if claims == nil {
		return false
	}
	for _, entry := range strings.Split(scoping, ",") {
		kind, value, found := strings.Cut(strings.TrimSpace(entry), ":")
		if !found || value == "" {
			continue
		}
		switch kind {
		case "group":
			for _, group := range claims.Groups {
				if group == value {
					return true
				}
			}
		case "user":
			if claims.Subject == value || claims.PreferredUsername == value {
				return true
			}
		case "email":
			if claims.EmailVerified && strings.EqualFold(claims.Email, value) {
				return true
			}
		}
	}
	return false
}

func verifiedActor(ctx context.Context) (actor, error) {
	if auth.AuthenticatedWithSSO(ctx) {
		claims := auth.GetClaims(ctx)
		if claims == nil || claims.OIDCIssuer == "" || claims.Subject == "" {
			return actor{}, errForbidden
		}
		display := claims.PreferredUsername
		if display == "" {
			display = claims.Subject
		}
		// A structured pair is unambiguous even when an issuer or subject contains a separator.
		pair, _ := json.Marshal([2]string{claims.OIDCIssuer, claims.Subject})
		return actor{id: "oidc:" + string(pair), display: display, claims: claims}, nil
	}
	review, err := auth.GetKubeClient(ctx).AuthenticationV1().SelfSubjectReviews().Create(ctx, &authenticationv1.SelfSubjectReview{}, metav1.CreateOptions{})
	if err != nil {
		return actor{}, err
	}
	user := review.Status.UserInfo
	if user.Username == "" || user.Username == "system:anonymous" {
		return actor{}, errForbidden
	}
	id := user.UID
	if id == "" {
		id = user.Username
	}
	return actor{id: "kubernetes:" + id, display: user.Username}, nil
}

func commentSuffix(comment string) string {
	if strings.TrimSpace(comment) == "" {
		return ""
	}
	return fmt.Sprintf(" (%s)", comment)
}
