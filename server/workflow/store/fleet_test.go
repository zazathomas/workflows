package store

import (
	"fmt"
	"testing"

	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
)

func TestFleetGateCountIsScopedAndNotPageLimited(t *testing.T) {
	s, err := NewSQLiteStore(instanceid.NewService(""))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.conn.Close() })
	ctx := t.Context()
	_, err = s.CountApprovalGates(ctx, "")
	require.ErrorIs(t, err, errGateProjectionPending)
	gate := wfv1.NodeStatus{Type: wfv1.NodeTypeSuspend, Phase: wfv1.NodeRunning, StartedAt: metav1.Now()}
	var snapshot []any
	for i := range 45 {
		name := fmt.Sprintf("run-%02d", i)
		snapshot = append(snapshot, &wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{UID: types.UID(name), Name: name, Namespace: "team"},
			Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowRunning, Nodes: wfv1.Nodes{"gate": gate}}})
	}
	packed := &wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{UID: "packed", Name: "packed", Namespace: "other"}, Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowRunning, OffloadNodeStatusVersion: "unresolved"}}
	require.NoError(t, s.Replace(append(snapshot, packed), "1"))
	count, err := s.CountApprovalGates(ctx, "team")
	require.NoError(t, err)
	require.EqualValues(t, 45, count)
	_, err = s.CountApprovalGates(ctx, "")
	require.ErrorIs(t, err, errGateProjectionPending)
	require.NoError(t, s.Delete(packed))
	count, err = s.CountApprovalGates(ctx, "")
	require.NoError(t, err)
	require.EqualValues(t, 45, count)
}

func TestFleetSubstringFiltersBeforePagination(t *testing.T) {
	s, err := NewSQLiteStore(instanceid.NewService(""))
	require.NoError(t, err)
	t.Cleanup(func() { _ = s.conn.Close() })
	var snapshot []any
	for i, title := range []string{"Preflight 100%_!", "Preflight 100aa", "Another 100%_!"} {
		name := fmt.Sprintf("run-%d", i)
		snapshot = append(snapshot, &wfv1.Workflow{ObjectMeta: metav1.ObjectMeta{UID: types.UID(name), Name: name, Namespace: "team",
			Annotations: map[string]string{"workflows.argoproj.io/title": title}, Labels: map[string]string{"team": "blue.deep"}}})
	}
	require.NoError(t, s.Replace(snapshot, "1"))
	opts := metav1.ListOptions{FieldSelector: "ext.nameTitleContains=464c4947485420313030255f21,ext.labelContains=3d626c75652e64656570", Limit: 1}
	ctx := logging.TestContext(t.Context())
	list, err := s.ListWorkflows(ctx, "team", "", "", "", opts)
	require.NoError(t, err)
	require.Len(t, list.Items, 1)
	require.Equal(t, "run-0", list.Items[0].Name)
	count, err := s.CountWorkflows(ctx, "team", "", "", "", opts)
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
}
