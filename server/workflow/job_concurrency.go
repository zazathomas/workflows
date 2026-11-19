package workflow

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"google.golang.org/grpc/codes"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	sutils "github.com/argoproj/argo-workflows/v4/server/utils"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/util"
)

// On-conflict policies (docs/job-concurrency.md).
const (
	JobConcurrencyConfigMap = "argo-job-concurrency"
	OnConflictQueue         = "queue"
	OnConflictReplace       = "replace"
	OnConflictReject        = "reject"
)

// jobControlAnnotationPrefixes are the annotation prefixes the server submit
// path copies from the Job (the submitted template) onto the workflow, so
// the dispatcher, the notification controller and the approvals handler can
// read the controls from the workflow alone. The workflow's own values win
// (a submit may override the Job's controls per run).
var jobControlAnnotationPrefixes = []string{
	common.AnnotationPrefixNotifications,
	"approvals.argoproj.io/",
}

// jobControlAnnotationKeys are the exact keys copied the same way.
var jobControlAnnotationKeys = []string{
	common.AnnotationKeyMaxConcurrentRuns,
	common.AnnotationKeyOnConflict,
	common.AnnotationKeyApprovalApprovers,
	common.AnnotationKeyApprovalExpiry,
	common.AnnotationKeyApprovalAutoApproveAfter,
}

// copyJobAnnotations copies the Job control annotations from the submitted
// resource (WorkflowTemplate, ClusterWorkflowTemplate or CronWorkflow) onto
// the workflow.
func isJobControlAnnotation(key string) bool {
	for _, prefix := range jobControlAnnotationPrefixes {
		if strings.HasPrefix(key, prefix) {
			return key != common.AnnotationKeyApprovalDecisions
		}
	}
	for _, exact := range jobControlAnnotationKeys {
		if key == exact {
			return true
		}
	}
	return false
}

func copyJobAnnotations(wf *wfv1.Workflow, src map[string]string) {
	if len(src) == 0 {
		return
	}
	if wf.Annotations == nil {
		wf.Annotations = map[string]string{}
	}
	for key, value := range src {
		if _, has := wf.Annotations[key]; !has && isJobControlAnnotation(key) {
			wf.Annotations[key] = value
		}
	}
}

// jobConcurrency reads and validates the max-concurrent-runs and on-conflict
// annotations of a workflow. max 0 means no cap.
func jobConcurrency(wf *wfv1.Workflow) (max int, onConflict string, err error) {
	onConflict = OnConflictQueue
	if raw := wf.Annotations[common.AnnotationKeyOnConflict]; raw != "" {
		switch raw {
		case OnConflictQueue, OnConflictReplace, OnConflictReject:
			onConflict = raw
		default:
			return 0, "", fmt.Errorf("%s must be one of %q, %q, %q, got %q",
				common.AnnotationKeyOnConflict, OnConflictQueue, OnConflictReplace, OnConflictReject, raw)
		}
	}
	raw := wf.Annotations[common.AnnotationKeyMaxConcurrentRuns]
	if raw == "" {
		return 0, onConflict, nil
	}
	max, parseErr := strconv.Atoi(raw)
	if parseErr != nil || max < 1 {
		return 0, "", fmt.Errorf("%s must be a positive integer, got %q", common.AnnotationKeyMaxConcurrentRuns, raw)
	}
	return max, onConflict, nil
}

// injectConcurrency adds a controller-enforced job lock. For limits above one
// the administrator provisions the named semaphore's capacity in a ConfigMap.
func injectConcurrency(wf *wfv1.Workflow) error {
	max, _, err := jobConcurrency(wf)
	if err != nil {
		return err
	}
	if max < 1 {
		return nil
	}
	if wf.Spec.Synchronization == nil {
		wf.Spec.Synchronization = &wfv1.Synchronization{}
	}
	name := jobMutexName(wf)
	if max == 1 {
		for _, mutex := range wf.Spec.Synchronization.Mutexes {
			if mutex != nil && mutex.Name == name && !mutex.Database && (mutex.Namespace == "" || mutex.Namespace == wf.Namespace) {
				return nil
			}
		}
		wf.Spec.Synchronization.Mutexes = append(wf.Spec.Synchronization.Mutexes, &wfv1.Mutex{Name: name})
		return nil
	}
	for _, semaphore := range wf.Spec.Synchronization.Semaphores {
		if semaphore != nil && semaphore.ConfigMapKeyRef != nil && semaphore.ConfigMapKeyRef.Name == JobConcurrencyConfigMap && semaphore.ConfigMapKeyRef.Key == name && (semaphore.Namespace == "" || semaphore.Namespace == wf.Namespace) {
			return nil
		}
	}
	wf.Spec.Synchronization.Semaphores = append(wf.Spec.Synchronization.Semaphores, &wfv1.SemaphoreRef{
		ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: JobConcurrencyConfigMap}, Key: name},
	})
	return nil
}

// jobMutexName is the synchronization mutex name of a workflow's Job. It is
// stable for the same Job across runs and distinct between Jobs.
func jobMutexName(wf *wfv1.Workflow) string {
	if name := wf.Labels[common.LabelKeyWorkflowTemplate]; name != "" {
		return "job-wt-" + name
	}
	if name := wf.Labels[common.LabelKeyClusterWorkflowTemplate]; name != "" {
		return "job-cwt-" + name
	}
	if name := wf.Labels[common.LabelKeyCronWorkflow]; name != "" {
		return "job-cron-" + name
	}
	return "job-wf-" + wf.Name
}

// resolveConflict enforces the on-conflict policy against the running runs
// of the same Job before a new run is created:
//
//   - queue (default): nothing to do here; the injected mutex makes the new
//     run wait its turn.
//   - replace: the previous run is stopped (its onExit handlers still run),
//     so the new run replaces it.
//   - reject: the submission is refused while a run of the Job is active.
//
// Only workflows submitted from a Job (a template or cron label) have a
// conflict to resolve; a directly created workflow's Job is itself, and
// workflow names are unique, so there is never a previous run to replace.
func (s *workflowServer) resolveConflict(ctx context.Context, wfClient versioned.Interface, wf *wfv1.Workflow) error {
	// StopWorkflow requires a logger in the context (the gRPC
	// interceptors put one there; be defensive for other callers).
	if logging.GetLoggerFromContextOrNil(ctx) == nil {
		ctx = logging.WithLogger(ctx, logging.NewSlogLogger(logging.Info, logging.Text))
	}
	_, onConflict, err := jobConcurrency(wf)
	if err != nil {
		return err
	}
	if onConflict == OnConflictQueue {
		return nil
	}
	running, err := listRunningWorkflowsOfJob(ctx, wfClient, wf)
	if err != nil {
		return err
	}
	if len(running) == 0 {
		return nil
	}
	if onConflict == OnConflictReject {
		return sutils.ToStatusError(
			fmt.Errorf("a run of this Job is already active (%s); %s is set to %q", running[0].Name, common.AnnotationKeyOnConflict, OnConflictReject),
			codes.AlreadyExists)
	}
	// Best-effort replacement: report partial failure without skipping other runs.
	var failed int
	logger := logging.RequireLoggerFromContext(ctx)
	for _, previous := range running {
		if err := util.StopWorkflow(ctx, wfClient.ArgoprojV1alpha1().Workflows(previous.Namespace), s.hydrator, previous.Name, "", "superseded by a newer run of the same Job"); err != nil && !apierrors.IsNotFound(err) {
			failed++
			logger.WithError(err).WithFields(logging.Fields{
				"namespace": previous.Namespace, "previousWorkflow": previous.Name, "replacementWorkflow": wf.Name,
			}).Warn(ctx, "could not stop previous run")
		}
	}
	if failed > 0 {
		return sutils.ToStatusError(fmt.Errorf("could not stop %d of %d previous runs", failed, len(running)), codes.Internal)
	}
	return nil
}

// listRunningWorkflowsOfJob lists the active runs of the workflow's Job (by
// template label). A workflow with no Job label returns nothing.
func listRunningWorkflowsOfJob(ctx context.Context, wfClient versioned.Interface, wf *wfv1.Workflow) ([]wfv1.Workflow, error) {
	labelSelector := jobLabelSelector(wf)
	if labelSelector == "" {
		return nil, nil
	}
	if wf.Namespace == "" {
		return nil, sutils.ToStatusError(fmt.Errorf("namespace is required"), codes.InvalidArgument)
	}
	options := metav1.ListOptions{LabelSelector: labelSelector}
	instanceid.NewService(wf.Labels[common.LabelKeyControllerInstanceID]).With(&options)
	list, err := wfClient.ArgoprojV1alpha1().Workflows(wf.Namespace).List(ctx, options)
	if err != nil {
		return nil, sutils.ToStatusError(fmt.Errorf("failed to list the runs of this Job: %w", err), codes.Internal)
	}
	var running []wfv1.Workflow
	for i := range list.Items {
		candidate := list.Items[i]
		if candidate.Name == wf.Name || (!wf.CreationTimestamp.IsZero() && candidate.CreationTimestamp.After(wf.CreationTimestamp.Time)) {
			continue
		}
		switch candidate.Status.Phase {
		case "", wfv1.WorkflowRunning, wfv1.WorkflowPending:
			running = append(running, candidate)
		}
	}
	return running, nil
}

// jobLabelSelector returns the label selector of a workflow's Job runs
// (empty when the workflow has no Job label).
func jobLabelSelector(wf *wfv1.Workflow) string {
	if name := wf.Labels[common.LabelKeyWorkflowTemplate]; name != "" {
		return fmt.Sprintf("%s=%s", common.LabelKeyWorkflowTemplate, name)
	}
	if name := wf.Labels[common.LabelKeyClusterWorkflowTemplate]; name != "" {
		return fmt.Sprintf("%s=%s", common.LabelKeyClusterWorkflowTemplate, name)
	}
	if name := wf.Labels[common.LabelKeyCronWorkflow]; name != "" {
		return fmt.Sprintf("%s=%s", common.LabelKeyCronWorkflow, name)
	}
	return ""
}
