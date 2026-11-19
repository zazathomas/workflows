package approvals

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/util/retry"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

const (
	recordPrefix = "argo-approval-"
	recordState  = "platform.argoproj.io/approval-state"
	pending      = "pending"
	applied      = "applied"
	stale        = "stale"
)

type gatePolicy struct {
	Approvers string `json:"approvers,omitempty"`
	Expiry    string `json:"expiry,omitempty"`
	Auto      string `json:"autoApproveAfter,omitempty"`
}

func policyOf(wf *wfv1.Workflow) gatePolicy {
	return gatePolicy{
		Approvers: wf.Annotations[common.AnnotationKeyApprovalApprovers],
		Expiry:    wf.Annotations[common.AnnotationKeyApprovalExpiry],
		Auto:      wf.Annotations[common.AnnotationKeyApprovalAutoApproveAfter],
	}
}

type gateRef struct {
	Workflow  string     `json:"workflow"`
	UID       string     `json:"workflowUID"`
	Node      string     `json:"nodeID"`
	StartedAt string     `json:"startedAt"`
	Policy    gatePolicy `json:"policy"`
}

func gateOf(wf *wfv1.Workflow, nodeID string, node wfv1.NodeStatus) gateRef {
	return gateRef{wf.Name, string(wf.UID), nodeID, node.StartedAt.UTC().Format(time.RFC3339Nano), policyOf(wf)}
}

func (g gateRef) key() string {
	sum := sha256.Sum256([]byte(g.UID + "\x00" + g.Node + "\x00" + g.StartedAt))
	return recordPrefix + hex.EncodeToString(sum[:])
}

type record struct {
	Gate gateRef `json:"gate"`
	Decision
}

type reconciler struct {
	wf       versioned.Interface
	kube     kubernetes.Interface
	hydrator hydrator.Interface
	instance instanceid.Service
}

// create is the arbitration point for a gate attempt. The immutable decision
// survives a crash between accepting the request and updating the Workflow.
func (r reconciler) create(ctx context.Context, namespace string, item record) (*corev1.ConfigMap, error) {
	raw, err := json.Marshal(item)
	if err != nil {
		return nil, err
	}
	immutable := true
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Namespace: namespace, Name: item.Gate.key(), Labels: map[string]string{recordState: pending}},
		Immutable:  &immutable,
		Data:       map[string]string{"decision.json": string(raw)},
	}
	if r.instance != nil {
		r.instance.Label(cm)
	}
	cm, err = r.kube.CoreV1().ConfigMaps(namespace).Create(ctx, cm, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		return nil, errConflict
	}
	return cm, err
}

func (r reconciler) load(ctx context.Context, namespace, name string) (*wfv1.Workflow, error) {
	wf, err := r.wf.ArgoprojV1alpha1().Workflows(namespace).Get(ctx, name, metav1.GetOptions{})
	if apierrors.IsNotFound(err) || (err == nil && r.instance != nil && r.instance.Validate(wf) != nil) {
		return nil, errNotFound
	}
	if err != nil {
		return nil, err
	}
	if err = r.hydrator.Hydrate(ctx, wf); err != nil {
		return nil, err
	}
	return wf, nil
}

func activeGate(wf *wfv1.Workflow, nodeID string) (wfv1.NodeStatus, error) {
	node, ok := wf.Status.Nodes[nodeID]
	if !ok || !node.IsActiveSuspendNode() || node.StartedAt.IsZero() || wf.UID == "" || wf.Status.Phase != wfv1.WorkflowRunning {
		return node, errNotFound
	}
	// Legacy annotations are not used as evidence that a gate is approved.
	// Refuse to write a second decision for a gate previously recorded there.
	if raw := wf.Annotations[common.AnnotationKeyApprovalDecisions]; raw != "" {
		var prior map[string]json.RawMessage
		if err := json.Unmarshal([]byte(raw), &prior); err != nil || prior == nil || prior[nodeID] != nil {
			return node, errConflict
		}
	}
	return node, nil
}

func (r reconciler) apply(ctx context.Context, cm *corev1.ConfigMap) error {
	if cm.Labels[recordState] != pending || (r.instance != nil && r.instance.Validate(cm) != nil) {
		return nil
	}
	var item record
	if cm.Immutable == nil || !*cm.Immutable || json.Unmarshal([]byte(cm.Data["decision.json"]), &item) != nil ||
		item.Gate.UID == "" || item.Actor == "" || item.Gate.key() != cm.Name || (item.Decision.Decision != "approve" && item.Decision.Decision != "reject") {
		return r.mark(ctx, cm, stale)
	}
	state := applied
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		wf, err := r.load(ctx, cm.Namespace, item.Gate.Workflow)
		if err != nil {
			return err
		}
		node, ok := wf.Status.Nodes[item.Gate.Node]
		if !ok || gateOf(wf, item.Gate.Node, node) != item.Gate {
			return errNotFound
		}
		phase := wfv1.NodeSucceeded
		if item.Decision.Decision == "reject" {
			phase = wfv1.NodeFailed
		}
		message := decisionMessage(item.Decision)
		if node.Phase == phase && node.Message == message && !node.FinishedAt.IsZero() {
			return nil // a previous attempt applied the decision but did not mark the record
		}
		if _, err := activeGate(wf, item.Gate.Node); err != nil {
			return err
		}
		node.Phase, node.Message = phase, message
		node.FinishedAt = metav1.Now()
		wf.Status.Nodes.Set(ctx, item.Gate.Node, node)
		if err := r.hydrator.Dehydrate(ctx, wf); err != nil {
			return err
		}
		_, err = r.wf.ArgoprojV1alpha1().Workflows(cm.Namespace).Update(ctx, wf, metav1.UpdateOptions{})
		return err
	})
	if errors.Is(err, errNotFound) || errors.Is(err, errConflict) {
		state = stale
	} else if err != nil {
		return err // leave the record pending for retry
	}
	if err := r.mark(ctx, cm, state); err != nil {
		return err
	}
	if state == stale {
		return errConflict
	}
	return nil
}

func decisionMessage(d Decision) string {
	if d.Actor == "policy:approval-timer" {
		return d.Comment
	}
	verb := "approved"
	if d.Decision == "reject" {
		verb = "rejected"
	}
	return fmt.Sprintf("%s by %s%s", verb, d.Approver, commentSuffix(d.Comment))
}

func (r reconciler) mark(ctx context.Context, cm *corev1.ConfigMap, state string) error {
	updated := cm.DeepCopy()
	updated.Labels[recordState] = state
	_, err := r.kube.CoreV1().ConfigMaps(cm.Namespace).Update(ctx, updated, metav1.UpdateOptions{})
	if apierrors.IsConflict(err) || apierrors.IsNotFound(err) {
		return nil // stale watch event; a newer record version owns the next attempt
	}
	return err
}

func recordSelector(instance instanceid.Service) metav1.ListOptions {
	opts := metav1.ListOptions{LabelSelector: recordState + "=" + pending, Limit: 100}
	if instance != nil {
		instance.With(&opts)
	}
	return opts
}

// isRecord is also used to ignore unrelated ConfigMaps from a permissive client.
func isRecord(cm *corev1.ConfigMap) bool {
	return strings.HasPrefix(cm.Name, recordPrefix) && cm.Labels[recordState] == pending
}
