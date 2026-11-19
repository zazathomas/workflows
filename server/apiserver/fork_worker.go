package apiserver

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/uuid"
	"k8s.io/client-go/tools/cache"
	"k8s.io/client-go/tools/leaderelection"
	"k8s.io/client-go/tools/leaderelection/resourcelock"
	"k8s.io/utils/env"

	wfv1 "github.com/argoproj/argo-workflows/v4/pkg/apis/workflow/v1alpha1"
	wflisters "github.com/argoproj/argo-workflows/v4/pkg/client/listers/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/server/approvals"
	"github.com/argoproj/argo-workflows/v4/server/fleetmetrics"
	"github.com/argoproj/argo-workflows/v4/server/notify"
	"github.com/argoproj/argo-workflows/v4/server/parameter"
	informerutil "github.com/argoproj/argo-workflows/v4/util/informer"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
	"github.com/argoproj/argo-workflows/v4/util/logging"
	"github.com/argoproj/argo-workflows/v4/workflow/hydrator"
)

// runForkWorker starts only fork reconcilers, without the API/UI, artifact
// routes, or the API server's cluster-wide workflow cache.
func (as *argoServer) runForkWorker(ctx context.Context, namespace string, instance instanceid.Service, hydrate hydrator.Interface) error {
	if !as.validExtensionNamespace(namespace) {
		return errors.New("ARGO_SERVER_FORK_WORKER_NAMESPACE must name a namespace managed by this server")
	}
	approvalNamespace := env.GetString("ARGO_SERVER_APPROVAL_NAMESPACE", "")
	if approvalNamespace != "" && approvalNamespace != namespace {
		return errors.New("approval namespace must match the worker namespace")
	}
	notifyHosts, err := parameter.ParseHosts(env.GetString("ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS", ""))
	if err != nil {
		return err
	}
	if approvalNamespace == "" && len(notifyHosts) == 0 {
		return errors.New("fork worker needs either approvals or notification hosts enabled")
	}

	log := logging.RequireLoggerFromContext(ctx)
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if address := env.GetString("ARGO_SERVER_FORK_WORKER_METRICS_ADDRESS", ""); address != "" {
		listener, err := net.Listen("tcp", address)
		if err != nil {
			return err
		}
		mux := http.NewServeMux()
		mux.Handle("/metrics", promhttp.Handler())
		metrics := &http.Server{Handler: mux, ReadHeaderTimeout: 3 * time.Second, WriteTimeout: 10 * time.Second}
		defer func() { _ = metrics.Close() }()
		go func() {
			if err := metrics.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
				log.WithError(err).Warn(ctx, "fork worker metrics listener failed")
			}
		}()
	}
	host, _ := os.Hostname()
	lock := &resourcelock.LeaseLock{
		LeaseMeta:  metav1.ObjectMeta{Namespace: namespace, Name: "argo-fork-worker"},
		Client:     as.clients.Kubernetes.CoordinationV1(),
		LockConfig: resourcelock.ResourceLockConfig{Identity: host + "-" + string(uuid.NewUUID())},
	}
	leaderErr := make(chan error, 1)
	elector, err := leaderelection.NewLeaderElector(leaderelection.LeaderElectionConfig{
		Lock:          lock,
		LeaseDuration: 30 * time.Second,
		RenewDeadline: 20 * time.Second,
		RetryPeriod:   5 * time.Second,
		// Don't release the lock early while a cancelled network send may still be unwinding.
		Callbacks: leaderelection.LeaderCallbacks{
			OnStartedLeading: func(leader context.Context) {
				log.WithField("namespace", namespace).Info(leader, "fork worker acquired lease")
				if err := as.startForkReconcilers(leader, namespace, approvalNamespace != "", instance, hydrate, hostSet(notifyHosts)); err != nil {
					leaderErr <- err
					stop()
				}
			},
			OnStoppedLeading: func() {},
		},
	})
	if err != nil {
		return err
	}
	elector.Run(ctx)
	select {
	case err := <-leaderErr:
		return err
	default:
		if ctx.Err() != nil {
			return nil
		}
		return errors.New("fork worker lost leadership")
	}
}

func (as *argoServer) startForkReconcilers(ctx context.Context, namespace string, approvalsEnabled bool, instance instanceid.Service, hydrate hydrator.Interface, hosts map[string]struct{}) error {
	log := logging.RequireLoggerFromContext(ctx)
	lw := informerutil.WorkflowListWatch(as.clients.Workflow.ArgoprojV1alpha1().Workflows(namespace), instance, "worker")
	informer := cache.NewSharedIndexInformer(lw, &wfv1.Workflow{}, time.Minute, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	workflows := trackedWorkflows{informer}
	var started bool
	start := func(stop <-chan struct{}) {
		if !started {
			started = true
			go informer.Run(stop)
		}
	}
	if err := workflows.Informer().SetTransform(informerutil.StripManagedFields); err != nil {
		return err
	}
	if approvalsEnabled {
		controller := approvals.NewController(approvals.ControllerConfig{
			WF: as.clients.Workflow, Kube: as.clients.Kubernetes, Hydrator: hydrate, Instance: instance,
			ManagedNamespace: namespace, Log: log, AllowAutoApprove: env.GetString("ARGO_SERVER_APPROVAL_AUTO_APPROVE", "") == "true",
		})
		if err := controller.RunWithInformer(ctx, workflows, start); err != nil {
			return err
		}
	}
	if len(hosts) != 0 {
		controller := notify.NewController(notify.ControllerConfig{
			WF: as.clients.Workflow, Kube: as.clients.Kubernetes, Hydrator: hydrate, Instance: instance,
			ManagedNamespace: namespace, InstallNamespace: as.namespace, Durable: true, AllowHosts: hosts,
			Instruments: fleetmetrics.NewInstruments(prometheus.DefaultRegisterer), Log: log,
		})
		if err := controller.RunWithInformer(ctx, workflows, start); err != nil {
			return err
		}
	}
	return nil
}

type trackedWorkflows struct {
	cache.SharedIndexInformer
}

func (w trackedWorkflows) Informer() cache.SharedIndexInformer { return w.SharedIndexInformer }
func (w trackedWorkflows) Lister() wflisters.WorkflowLister {
	return wflisters.NewWorkflowLister(w.GetIndexer())
}
