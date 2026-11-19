package workflow

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	kubefake "k8s.io/client-go/kubernetes/fake"
	ktesting "k8s.io/client-go/testing"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/server/auth"
	"github.com/argoproj/argo-workflows/v4/server/workflow/store"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

func TestRunViewAuthorizesBeforeProjectingGates(t *testing.T) {
	lister, err := store.NewSQLiteStore(instanceid.NewService(""))
	require.NoError(t, err)
	wf := &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{Name: "run", Namespace: "team", UID: "test-uid", Labels: map[string]string{common.LabelKeyPhase: string(wfv1.WorkflowRunning)}, Annotations: map[string]string{"private": "annotation-value"}},
		Spec:       wfv1.WorkflowSpec{Entrypoint: "private-entrypoint"},
		Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowRunning, Nodes: wfv1.Nodes{
			"gate": {ID: "gate", Name: "gate", Type: wfv1.NodeTypeSuspend, Phase: wfv1.NodeRunning, StartedAt: metav1.Now(), Message: "private-message"},
			"pod":  {ID: "pod", Type: wfv1.NodeTypePod, Phase: wfv1.NodeRunning},
		}},
	}
	require.NoError(t, lister.Add(wf))
	kube := kubefake.NewSimpleClientset()
	kube.PrependReactor("create", "selfsubjectaccessreviews", func(action ktesting.Action) (bool, runtime.Object, error) {
		review := action.(ktesting.CreateAction).GetObject().(*authorizationv1.SelfSubjectAccessReview)
		a := review.Spec.ResourceAttributes
		review.Status.Allowed = a.Namespace == "team" && a.Verb == "list" && a.Resource == "workflows"
		return true, review, nil
	})
	h := NewRunView(lister, hydrator.New(nil))
	ctx := auth.WithCallerScopedCredentials(context.WithValue(logging.TestContext(t.Context()), auth.KubeKey, kube))
	for _, tc := range []struct {
		name string
		code int
	}{{"team", http.StatusOK}, {"other", http.StatusForbidden}, {"", http.StatusForbidden}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequestWithContext(ctx, http.MethodGet, "/?view=gates&namespace="+tc.name, nil))
		require.Equal(t, tc.code, w.Code, w.Body.String())
		assert.NotContains(t, w.Body.String(), "private-")
		assert.NotContains(t, w.Body.String(), "annotation-value")
		if tc.code == http.StatusOK {
			var out wfv1.WorkflowList
			require.NoError(t, json.Unmarshal(w.Body.Bytes(), &out))
			require.Len(t, out.Items, 1)
			require.Contains(t, out.Items[0].Status.Nodes, "gate")
			assert.NotContains(t, out.Items[0].Status.Nodes, "pod")
		}
	}
}
