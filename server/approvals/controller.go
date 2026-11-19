package approvals

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/util/workqueue"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned"
	informers "github.com/argoproj/argo-workflows/v4/pkg/client/informers/externalversions"
	wfsv1alpha1 "github.com/argoproj/argo-workflows/v4/pkg/client/informers/externalversions/workflow/v1alpha1"
	informerutil "github.com/argoproj/argo-workflows/v4/util/informer"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/common"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

// ControllerConfig configures a Controller.
type ControllerConfig struct {
	WF               versioned.Interface
	Kube             kubernetes.Interface
	AllowAutoApprove bool
	Hydrator         hydrator.Interface
	ManagedNamespace string
	Instance         instanceid.Service
	Log              logging.Logger
	Now              func() time.Time
}

// Controller watches Workflows and applies the approval timers: a suspended
// step still waiting past the Job's expiry is denied (its node fails, the
// run continues with onExit and later steps), and one waiting past the
// auto-approve wait timer is approved (docs/approvals.md). Both act through
// the suspended-node path, like a human decision.
type Controller struct {
	reconciler
	managedNamespace string
	allowAutoApprove bool
	log              logging.Logger
	now              func() time.Time
}

// NewController creates the approvals Controller.
func NewController(cfg ControllerConfig) *Controller {
	now := cfg.Now
	if now == nil {
		now = time.Now
	}
	return &Controller{
		reconciler:       reconciler{wf: cfg.WF, kube: cfg.Kube, hydrator: cfg.Hydrator, instance: cfg.Instance},
		managedNamespace: cfg.ManagedNamespace,
		allowAutoApprove: cfg.AllowAutoApprove,
		log:              cfg.Log,
		now:              now,
	}
}

// Run starts the workflow informer and the timer loop, and blocks until the
// informer cache has synced, then returns (the loop runs until ctx is done).
func (c *Controller) Run(ctx context.Context) error {
	factory := informers.NewSharedInformerFactoryWithOptions(c.wf, resync,
		informers.WithNamespace(c.managedNamespace), informers.WithTweakListOptions(func(options *metav1.ListOptions) {
			if c.instance != nil {
				c.instance.With(options)
			}
		}))
	informer := factory.Argoproj().V1alpha1().Workflows()
	if err := informer.Informer().SetTransform(informerutil.StripManagedFields); err != nil {
		return err
	}
	return c.RunWithInformer(ctx, informer, factory.Start)
}

// RunWithInformer shares a single watch across extension reconcilers.
func (c *Controller) RunWithInformer(ctx context.Context, informer wfsv1alpha1.WorkflowInformer, start func(<-chan struct{})) error {
	queue := workqueue.NewTypedDelayingQueue[[2]string]()
	enqueue := func(obj any) {
		if wf, ok := obj.(*wfv1.Workflow); ok && wf.Status.Phase == wfv1.WorkflowRunning &&
			(wf.Annotations[common.AnnotationKeyApprovalExpiry] != "" || (c.allowAutoApprove && wf.Annotations[common.AnnotationKeyApprovalAutoApproveAfter] != "")) {
			queue.Add([2]string{wf.Namespace, wf.Name})
		}
	}
	_, err := informer.Informer().AddEventHandler(cache.ResourceEventHandlerFuncs{AddFunc: enqueue, UpdateFunc: func(_, obj any) { enqueue(obj) }})
	if err != nil {
		return fmt.Errorf("registering workflow informer handler: %w", err)
	}
	start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), informer.Informer().HasSynced) {
		return fmt.Errorf("workflow informer cache did not sync")
	}
	go func() {
		<-ctx.Done()
		queue.ShutDown()
	}()
	go func() {
		for {
			key, shutdown := queue.Get()
			if shutdown {
				return
			}
			if wf, err := informer.Lister().Workflows(key[0]).Get(key[1]); err == nil {
				if next := c.applyTimers(ctx, wf); !next.IsZero() {
					queue.AddAfter(key, next.Sub(c.now()))
				}
			}
			queue.Done(key)
		}
	}()
	go func() {
		ticker := time.NewTicker(3 * time.Second)
		defer ticker.Stop()
		for ctx.Err() == nil {
			c.reconcilePending(ctx)
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
			}
		}
	}()
	return nil
}

// applyTimers applies the expiry and wait timers to one workflow's suspended
// steps. Already-decided steps are skipped (the decisions annotation).
func (c *Controller) applyTimers(ctx context.Context, wf *wfv1.Workflow) (next time.Time) {
	ctx = c.withLogger(ctx)
	if wf == nil || wf.Status.Phase != wfv1.WorkflowRunning {
		return next
	}
	expiry := parseDurationAnnotation(wf, common.AnnotationKeyApprovalExpiry)
	var autoApprove time.Duration
	if c.allowAutoApprove {
		autoApprove = parseDurationAnnotation(wf, common.AnnotationKeyApprovalAutoApproveAfter)
	}
	if expiry <= 0 && autoApprove <= 0 {
		return next
	}
	if !c.hydrator.IsHydrated(wf) {
		wf = wf.DeepCopy()
		if err := c.hydrator.Hydrate(ctx, wf); err != nil {
			c.log.WithError(err).Warn(ctx, "could not hydrate approval timers")
			return c.now().Add(tick)
		}
	}
	for nodeID := range wf.Status.Nodes {
		node, err := activeGate(wf, nodeID)
		if err != nil {
			continue
		}
		now := c.now().UTC()
		waited := now.Sub(node.StartedAt.Time)
		item := record{Gate: gateOf(wf, nodeID, node), Decision: Decision{Actor: "policy:approval-timer", Approver: "approval timer", At: now.Format(time.RFC3339Nano)}}
		switch {
		case expiry > 0 && waited >= expiry:
			item.Decision.Decision = "reject"
			item.Comment = fmt.Sprintf("denied automatically: no decision within %s", expiry)
		case autoApprove > 0 && waited >= autoApprove:
			item.Decision.Decision = "approve"
			item.Comment = fmt.Sprintf("approved automatically after the %s wait timer", autoApprove)
		default:
			for _, interval := range []time.Duration{expiry, autoApprove} {
				if due := node.StartedAt.Add(interval); interval > 0 && (next.IsZero() || due.Before(next)) {
					next = due
				}
			}
			continue
		}
		cm, err := c.create(ctx, wf.Namespace, item)
		if err == nil {
			err = c.apply(ctx, cm)
		}
		if err != nil && !errors.Is(err, errConflict) {
			c.log.WithError(err).Warn(ctx, "could not reconcile approval timer")
			if retry := now.Add(tick); next.IsZero() || retry.Before(next) {
				next = retry
			}
		}
	}
	return next
}

func (c *Controller) reconcilePending(ctx context.Context) {
	ctx = c.withLogger(ctx)
	options := recordSelector(c.instance)
	maps := c.kube.CoreV1().ConfigMaps(c.managedNamespace)
	for {
		page, err := maps.List(ctx, options)
		if err != nil {
			c.log.WithError(err).Warn(ctx, "could not list pending approval records")
			return
		}
		for i := range page.Items {
			if cm := &page.Items[i]; isRecord(cm) {
				if err := c.apply(ctx, cm); err != nil && !errors.Is(err, errConflict) {
					c.log.WithError(err).WithField("record", cm.Name).Warn(ctx, "could not apply pending approval record")
				}
			}
		}
		if page.Continue == "" {
			return
		}
		options.Continue = page.Continue
	}
}

func parseDurationAnnotation(wf *wfv1.Workflow, key string) time.Duration {
	raw := strings.TrimSpace(wf.Annotations[key])
	if raw == "" {
		return 0
	}
	duration, err := time.ParseDuration(raw)
	if err != nil || duration <= 0 {
		return 0
	}
	return duration
}

func (c *Controller) withLogger(ctx context.Context) context.Context {
	if logger := logging.GetLoggerFromContextOrNil(ctx); logger != nil {
		return ctx
	}
	return logging.WithLogger(ctx, c.log)
}
