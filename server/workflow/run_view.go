package workflow

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/validation"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/server/workflow/store"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

var runViewLatency = promauto.NewHistogramVec(prometheus.HistogramOpts{
	Name: "argo_fork_run_view_duration_seconds",
	Help: "Latency of authorized fork run-view requests.",
}, []string{"view"})

// RunView returns a compact projection from the server's existing reflected
// Workflow store. The projections do not include Workflow specs, parameters,
// or non-gate node data, and never query the archive's offloaded nodes in bulk.
type RunView struct {
	store interface {
		store.WorkflowLister
		CountApprovalGates(context.Context, string) (int64, error)
	}
	hydrator hydrator.Interface
	slots    chan struct{}
}

func NewRunView(lister *store.SQLiteStore, hydrate hydrator.Interface) *RunView {
	return &RunView{store: lister, hydrator: hydrate, slots: make(chan struct{}, 8)}
}

func (h *RunView) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "GET required", http.StatusMethodNotAllowed)
		return
	}
	if !auth.CanUseParameterSources(r.Context()) {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	q := r.URL.Query()
	namespace := q.Get("namespace")
	if namespace != "" && len(validation.IsDNS1123Label(namespace)) != 0 {
		http.Error(w, "invalid namespace", http.StatusBadRequest)
		return
	}
	view := q.Get("view")
	gates := view == "gates"
	if !gates && view != "summary" && view != "gate-count" {
		http.Error(w, "invalid view", http.StatusBadRequest)
		return
	}
	limit := 160
	if gates {
		limit = 32
	}
	offset := 0
	if raw := q.Get("continue"); raw != "" {
		var err error
		offset, err = strconv.Atoi(raw)
		if err != nil || offset < 0 || offset > 1_000_000 {
			http.Error(w, "invalid cursor", http.StatusBadRequest)
			return
		}
	}
	select {
	case h.slots <- struct{}{}:
		defer func() { <-h.slots }()
	default:
		http.Error(w, "run view is busy", http.StatusTooManyRequests)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	allowed, err := auth.CanI(ctx, "list", "workflows", namespace, "")
	if err != nil {
		http.Error(w, "could not check Workflow access", http.StatusServiceUnavailable)
		return
	}
	if !allowed {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	started := time.Now()
	defer func() { runViewLatency.WithLabelValues(view).Observe(time.Since(started).Seconds()) }()
	if view == "gate-count" {
		count, err := h.store.CountApprovalGates(ctx, namespace)
		if err != nil {
			w.Header().Set("Retry-After", "5")
			http.Error(w, "approval count is not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(struct {
			Count int64 `json:"count"`
		}{count})
		return
	}
	opts := metav1.ListOptions{Limit: int64(limit + 1), Continue: strconv.Itoa(offset)}
	if gates {
		opts.LabelSelector = common.LabelKeyPhase + "=" + string(wfv1.WorkflowRunning)
	}
	list, err := h.store.ListWorkflows(ctx, namespace, "", "", "", opts)
	if err != nil {
		logging.RequireLoggerFromContext(ctx).WithError(err).Warn(ctx, "run view failed")
		http.Error(w, "run view unavailable", http.StatusServiceUnavailable)
		return
	}
	out := wfv1.WorkflowList{Items: make([]wfv1.Workflow, 0, limit)}
	if len(list.Items) > limit {
		out.Continue = strconv.Itoa(offset + limit)
		list.Items = list.Items[:limit]
	}
	for i := range list.Items {
		wf := &list.Items[i]
		if gates {
			if err := h.hydrator.Hydrate(ctx, wf); err != nil {
				logging.RequireLoggerFromContext(ctx).WithError(err).Warn(ctx, "gate view could not load workflow nodes")
				http.Error(w, "gate view unavailable", http.StatusServiceUnavailable)
				return
			}
		}
		if summary, ok := projectWorkflow(wf, gates); ok {
			out.Items = append(out.Items, summary)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

func projectWorkflow(wf *wfv1.Workflow, gates bool) (wfv1.Workflow, bool) {
	out := wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{Name: wf.Name, Namespace: wf.Namespace, UID: wf.UID, CreationTimestamp: wf.CreationTimestamp},
		Status:     wfv1.WorkflowStatus{Phase: wf.Status.Phase, StartedAt: wf.Status.StartedAt, FinishedAt: wf.Status.FinishedAt},
	}
	for _, key := range []string{common.LabelKeyWorkflowTemplate, common.LabelKeyClusterWorkflowTemplate, common.LabelKeyCronWorkflow} {
		if value := wf.Labels[key]; value != "" {
			if out.Labels == nil {
				out.Labels = make(map[string]string, 3)
			}
			out.Labels[key] = value
		}
	}
	if gates {
		if wf.Status.Phase != wfv1.WorkflowRunning {
			return out, false
		}
		for nodeID, node := range wf.Status.Nodes {
			if node.IsActiveSuspendNode() && !node.StartedAt.IsZero() {
				if out.Status.Nodes == nil {
					out.Status.Nodes = make(wfv1.Nodes)
				}
				out.Status.Nodes[nodeID] = wfv1.NodeStatus{ID: nodeID, Name: node.Name, DisplayName: node.DisplayName, StartedAt: node.StartedAt, Type: node.Type, Phase: node.Phase}
			}
		}
	}
	return out, !gates || len(out.Status.Nodes) != 0
}
