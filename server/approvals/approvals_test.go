package approvals

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	authorizationv1 "k8s.io/api/authorization/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	kubefake "k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wffake "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned/fake"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	authtypes "github.com/argoproj/argo-workflows/v4/server/auth/types"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

const ns = "team"

var started = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func suspendedWorkflow(annotations map[string]string) *wfv1.Workflow {
	return &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{Name: "wf-1", Namespace: ns, UID: types.UID("uid-1"), Annotations: annotations},
		Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowRunning, Nodes: wfv1.Nodes{
			"gate": {ID: "gate", Name: "wait-for-approval", Type: wfv1.NodeTypeSuspend, Phase: wfv1.NodeRunning, StartedAt: metav1.NewTime(started)},
		}},
	}
}

func newTestHandler(t *testing.T, wf *wfv1.Workflow, grant bool) (*Handler, *wffake.Clientset, *kubefake.Clientset) {
	t.Helper()
	workflows := wffake.NewSimpleClientset(wf)
	kube := kubefake.NewSimpleClientset()
	kube.PrependReactor("create", "selfsubjectaccessreviews", func(action ktesting.Action) (bool, runtime.Object, error) {
		review := action.(ktesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview)
		attrs := review.Spec.ResourceAttributes
		review.Status.Allowed = grant && attrs.Group == "platform.argoproj.io" && attrs.Resource == "workflowapprovals" && attrs.Verb == "decide" && attrs.Namespace == ns && attrs.Name == wf.Name
		return true, review, nil
	})
	h := NewHandler(workflows, kube, hydrator.New(nil), logging.NewTestLogger(logging.Info, logging.Text))
	h.nowFunc = func() time.Time { return started.Add(time.Hour) }
	h.identity = func(ctx context.Context) (actor, error) {
		return actor{id: "oidc:test/1", display: "alice", claims: auth.GetClaims(ctx)}, nil
	}
	return h, workflows, kube
}

func decide(t *testing.T, h *Handler, claims *authtypes.Claims, uid string, at time.Time, verb string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(decisionRequestBody{Decision: verb, Comment: "looks good", WorkflowUID: uid, StartedAt: at.Format(time.RFC3339Nano)})
	require.NoError(t, err)
	req := httptest.NewRequestWithContext(t.Context(), http.MethodPost, PathPrefix+"/"+ns+"/wf-1/gate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	ctx := context.WithValue(req.Context(), auth.KubeKey, h.kube)
	ctx = context.WithValue(ctx, auth.ClaimsKey, claims)
	recorder := httptest.NewRecorder()
	h.ServeHTTP(recorder, req.WithContext(auth.WithCallerScopedCredentials(ctx)))
	return recorder
}

func TestDecisionAppliesAndRecordsVerifiedActor(t *testing.T) {
	for _, test := range []struct {
		verb string
		want wfv1.NodePhase
	}{{"approve", wfv1.NodeSucceeded}, {"reject", wfv1.NodeFailed}} {
		t.Run(test.verb, func(t *testing.T) {
			original := suspendedWorkflow(nil)
			h, workflows, kube := newTestHandler(t, original, true)
			response := decide(t, h, nil, string(original.UID), started, test.verb)
			require.Equal(t, http.StatusNoContent, response.Code, response.Body.String())
			wf, err := workflows.ArgoprojV1alpha1().Workflows(ns).Get(t.Context(), original.Name, metav1.GetOptions{})
			require.NoError(t, err)
			assert.Equal(t, test.want, wf.Status.Nodes["gate"].Phase)
			assert.Contains(t, wf.Status.Nodes["gate"].Message, "alice")
			assert.Empty(t, wf.Spec.Shutdown)
			assert.Empty(t, wf.Annotations[common.AnnotationKeyApprovalDecisions])
			cm, err := kube.CoreV1().ConfigMaps(ns).Get(t.Context(), gateOf(original, "gate", original.Status.Nodes["gate"]).key(), metav1.GetOptions{})
			require.NoError(t, err)
			require.NotNil(t, cm.Immutable)
			assert.True(t, *cm.Immutable)
			assert.Equal(t, applied, cm.Labels[recordState])
			var saved record
			require.NoError(t, json.Unmarshal([]byte(cm.Data["decision.json"]), &saved))
			assert.Equal(t, "oidc:test/1", saved.Actor)
			assert.Equal(t, test.verb, saved.Decision.Decision)
			assert.Equal(t, "looks good", saved.Comment)
		})
	}
}

func TestDecisionFailsClosed(t *testing.T) {
	for _, test := range []struct {
		desc, uid, approvers, expiry string
		at                           time.Time
		grant                        bool
		claims                       *authtypes.Claims
		want                         int
	}{
		{"missing grant", "uid-1", "", "", started, false, nil, http.StatusForbidden},
		{"wrong group", "uid-1", "group:ops", "", started, true, &authtypes.Claims{Groups: []string{"OPS"}}, http.StatusForbidden},
		{"unverified email", "uid-1", "email:alice@example.com", "", started, true, &authtypes.Claims{Email: "alice@example.com"}, http.StatusForbidden},
		{"verified email", "uid-1", "email:alice@example.com", "", started, true, &authtypes.Claims{Email: "alice@example.com", EmailVerified: true}, http.StatusNoContent},
		{"old uid", "old", "", "", started, true, nil, http.StatusConflict},
		{"old attempt", "uid-1", "", "", started.Add(-time.Minute), true, nil, http.StatusConflict},
		{"deadline passed", "uid-1", "", "30m", started, true, nil, http.StatusConflict},
	} {
		t.Run(test.desc, func(t *testing.T) {
			h, _, _ := newTestHandler(t, suspendedWorkflow(map[string]string{common.AnnotationKeyApprovalApprovers: test.approvers, common.AnnotationKeyApprovalExpiry: test.expiry}), test.grant)
			assert.Equal(t, test.want, decide(t, h, test.claims, test.uid, test.at, "approve").Code)
		})
	}
}

func TestReconcileAcceptedDecisionAfterWriteFailure(t *testing.T) {
	wf := suspendedWorkflow(nil)
	h, workflows, kube := newTestHandler(t, wf, true)
	fail := true
	workflows.PrependReactor("update", "workflows", func(ktesting.Action) (bool, runtime.Object, error) {
		if fail {
			return true, nil, apierrors.NewServiceUnavailable("disconnected")
		}
		return false, nil, nil
	})
	assert.Equal(t, http.StatusAccepted, decide(t, h, nil, string(wf.UID), started, "approve").Code)
	assert.Equal(t, http.StatusConflict, decide(t, h, nil, string(wf.UID), started, "reject").Code)
	fail = false
	controller := NewController(ControllerConfig{WF: workflows, Kube: kube, Hydrator: h.hydrator, Log: h.log, ManagedNamespace: ns})
	controller.reconcilePending(t.Context())
	current, err := workflows.ArgoprojV1alpha1().Workflows(ns).Get(t.Context(), wf.Name, metav1.GetOptions{})
	require.NoError(t, err)
	assert.Equal(t, wfv1.NodeSucceeded, current.Status.Nodes["gate"].Phase)
}

func TestApprovalTimers(t *testing.T) {
	for _, test := range []struct {
		expiry, auto string
		allowAuto    bool
		want         wfv1.NodePhase
	}{
		{"30m", "10m", true, wfv1.NodeFailed},
		{"", "10m", true, wfv1.NodeSucceeded},
		{"", "10m", false, wfv1.NodeRunning},
		{"", "", false, wfv1.NodeRunning},
	} {
		wf := suspendedWorkflow(map[string]string{common.AnnotationKeyApprovalExpiry: test.expiry, common.AnnotationKeyApprovalAutoApproveAfter: test.auto})
		h, workflows, kube := newTestHandler(t, wf, true)
		c := NewController(ControllerConfig{WF: workflows, Kube: kube, Hydrator: h.hydrator, Log: h.log, AllowAutoApprove: test.allowAuto, Now: h.nowFunc})
		c.applyTimers(t.Context(), wf)
		current, err := workflows.ArgoprojV1alpha1().Workflows(ns).Get(t.Context(), wf.Name, metav1.GetOptions{})
		require.NoError(t, err)
		assert.Equal(t, test.want, current.Status.Nodes["gate"].Phase)
	}
}
