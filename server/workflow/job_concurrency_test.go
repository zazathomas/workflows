package workflow

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wffake "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned/fake"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
)

func jobWorkflow(annotations map[string]string, labels map[string]string) *wfv1.Workflow {
	return &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "run-1",
			Namespace:   "ns",
			UID:         types.UID("uid-1"),
			Annotations: annotations,
			Labels:      labels,
		},
	}
}

func TestInjectConcurrency(t *testing.T) {
	// A limit of one injects the workflow mutex.
	wf := jobWorkflow(map[string]string{common.AnnotationKeyMaxConcurrentRuns: "1"},
		map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})
	require.NoError(t, injectConcurrency(wf))
	require.NotNil(t, wf.Spec.Synchronization)
	require.Len(t, wf.Spec.Synchronization.Mutexes, 1)
	assert.Equal(t, "job-wt-tpl", wf.Spec.Synchronization.Mutexes[0].Name)

	// The mutex matches the Job identity the dispatcher counts (the claim
	// label prefix "wt-").
	assert.Contains(t, wf.Spec.Synchronization.Mutexes[0].Name, "wt-tpl")

	// No annotation: nothing injected.
	wf = jobWorkflow(nil, nil)
	require.NoError(t, injectConcurrency(wf))
	assert.Nil(t, wf.Spec.Synchronization)

	// A larger limit adds a semaphore and preserves existing locks.
	wf = jobWorkflow(map[string]string{common.AnnotationKeyMaxConcurrentRuns: "3"}, nil)
	wf.Spec.Synchronization = &wfv1.Synchronization{Mutexes: []*wfv1.Mutex{{Name: "author-lock"}}}
	require.NoError(t, injectConcurrency(wf))
	require.Len(t, wf.Spec.Synchronization.Mutexes, 1)
	assert.Equal(t, "author-lock", wf.Spec.Synchronization.Mutexes[0].Name)
	require.Len(t, wf.Spec.Synchronization.Semaphores, 1)
	assert.Equal(t, JobConcurrencyConfigMap, wf.Spec.Synchronization.Semaphores[0].ConfigMapKeyRef.Name)
	assert.Equal(t, "job-wf-run-1", wf.Spec.Synchronization.Semaphores[0].ConfigMapKeyRef.Key)

	// An invalid annotation is rejected.
	wf = jobWorkflow(map[string]string{common.AnnotationKeyMaxConcurrentRuns: "three"}, nil)
	assert.Error(t, injectConcurrency(wf))
	wf = jobWorkflow(map[string]string{common.AnnotationKeyOnConflict: "explode"}, nil)
	assert.Error(t, injectConcurrency(wf))
}

func TestCopyJobAnnotations(t *testing.T) {
	wf := jobWorkflow(nil, nil)
	src := map[string]string{
		common.AnnotationKeyMaxConcurrentRuns:                 "2",
		common.AnnotationKeyOnConflict:                        "replace",
		common.AnnotationKeyApprovalApprovers:                 "group:eng-leads",
		common.AnnotationKeyApprovalExpiry:                    "30m",
		common.AnnotationPrefixNotifications + "destinations": "slack",
		common.AnnotationPrefixNotifications + "triggers":     "failed",
		"unrelated.argoproj.io/thing":                         "kept out",
	}
	copyJobAnnotations(wf, src)
	assert.Equal(t, "2", wf.Annotations[common.AnnotationKeyMaxConcurrentRuns])
	assert.Equal(t, "replace", wf.Annotations[common.AnnotationKeyOnConflict])
	assert.Equal(t, "group:eng-leads", wf.Annotations[common.AnnotationKeyApprovalApprovers])
	assert.Equal(t, "30m", wf.Annotations[common.AnnotationKeyApprovalExpiry])
	assert.Equal(t, "slack", wf.Annotations[common.AnnotationPrefixNotifications+"destinations"])
	assert.Equal(t, "failed", wf.Annotations[common.AnnotationPrefixNotifications+"triggers"])
	assert.NotContains(t, wf.Annotations, "unrelated.argoproj.io/thing")

	// The workflow's own values win over the Job's.
	wf = jobWorkflow(map[string]string{common.AnnotationKeyOnConflict: "reject"}, nil)
	copyJobAnnotations(wf, src)
	assert.Equal(t, "reject", wf.Annotations[common.AnnotationKeyOnConflict])
}

func TestResolveConflictRejectAndReplace(t *testing.T) {
	server := &workflowServer{hydrator: nil}
	running := &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "run-previous",
			Namespace: "ns",
			UID:       types.UID("uid-prev"),
			Labels:    map[string]string{common.LabelKeyWorkflowTemplate: "tpl"},
		},
		Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowRunning},
	}
	newRun := jobWorkflow(
		map[string]string{common.AnnotationKeyOnConflict: "reject"},
		map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})

	t.Run("reject", func(t *testing.T) {
		wfFake := wffake.NewSimpleClientset(running)
		err := server.resolveConflict(t.Context(), wfFake, newRun)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "already active")
		// The previous run was not stopped.
		current, err := wfFake.ArgoprojV1alpha1().Workflows("ns").Get(t.Context(), "run-previous", metav1.GetOptions{})
		require.NoError(t, err)
		assert.Empty(t, current.Spec.Shutdown)
	})

	t.Run("replace stops the previous run", func(t *testing.T) {
		newRun := jobWorkflow(
			map[string]string{common.AnnotationKeyOnConflict: "replace"},
			map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})
		wfFake := wffake.NewSimpleClientset(running)
		require.NoError(t, server.resolveConflict(t.Context(), wfFake, newRun))
		current, err := wfFake.ArgoprojV1alpha1().Workflows("ns").Get(t.Context(), "run-previous", metav1.GetOptions{})
		require.NoError(t, err)
		assert.Equal(t, wfv1.ShutdownStrategyStop, current.Spec.Shutdown, "the previous run was stopped (onExit handlers still run)")
	})

	t.Run("queue does nothing", func(t *testing.T) {
		newRun := jobWorkflow(
			map[string]string{common.AnnotationKeyOnConflict: "queue"},
			map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})
		wfFake := wffake.NewSimpleClientset(running)
		require.NoError(t, server.resolveConflict(t.Context(), wfFake, newRun))
		current, err := wfFake.ArgoprojV1alpha1().Workflows("ns").Get(t.Context(), "run-previous", metav1.GetOptions{})
		require.NoError(t, err)
		assert.Empty(t, current.Spec.Shutdown)
	})

	t.Run("no job label means no conflict", func(t *testing.T) {
		newRun := jobWorkflow(map[string]string{common.AnnotationKeyOnConflict: "reject"}, nil)
		wfFake := wffake.NewSimpleClientset(running)
		require.NoError(t, server.resolveConflict(t.Context(), wfFake, newRun))
	})
}

func TestResolveConflictIgnoresFinishedRuns(t *testing.T) {
	// Only Running and Pending runs conflict; finished ones do not.
	finished := &wfv1.Workflow{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "run-old",
			Namespace: "ns",
			UID:       types.UID("uid-old"),
			Labels:    map[string]string{common.LabelKeyWorkflowTemplate: "tpl"},
		},
		Status: wfv1.WorkflowStatus{Phase: wfv1.WorkflowSucceeded},
	}
	newRun := jobWorkflow(
		map[string]string{common.AnnotationKeyOnConflict: "reject"},
		map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})
	server := &workflowServer{}
	require.NoError(t, server.resolveConflict(t.Context(), wffake.NewSimpleClientset(finished), newRun))
}

func TestJobMutexName(t *testing.T) {
	wf := jobWorkflow(nil, map[string]string{common.LabelKeyWorkflowTemplate: "tpl"})
	assert.Equal(t, "job-wt-tpl", jobMutexName(wf))
	wf.Labels = map[string]string{common.LabelKeyClusterWorkflowTemplate: "ctpl"}
	assert.Equal(t, "job-cwt-ctpl", jobMutexName(wf))
	wf.Labels = map[string]string{common.LabelKeyCronWorkflow: "cron"}
	assert.Equal(t, "job-cron-cron", jobMutexName(wf))
	wf.Labels = nil
	assert.Equal(t, "job-wf-run-1", jobMutexName(wf))
}
