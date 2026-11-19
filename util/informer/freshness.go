package informer

import (
	"context"
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/tools/cache"

	typed "github.com/argoproj/argo-workflows/v4/pkg/client/clientset/versioned/typed/workflow/v1alpha1"
	"github.com/argoproj/argo-workflows/v4/util/instanceid"
)

var lastWorkflowProgress = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "argo_fork_workflow_informer_last_progress_timestamp_seconds",
	Help: "Unix time of the last successful workflow list, watch event or bookmark; quiet watches need not produce events.",
}, []string{"role"})

var openWorkflowWatches = promauto.NewGaugeVec(prometheus.GaugeOpts{
	Name: "argo_fork_workflow_informer_open_watches",
	Help: "Number of open upstream workflow watch streams by process role.",
}, []string{"role"})

func WorkflowListWatch(client typed.WorkflowInterface, instance instanceid.Service, role string) *cache.ListWatch {
	lastWorkflowProgress.WithLabelValues(role)
	openWorkflowWatches.WithLabelValues(role)
	return &cache.ListWatch{
		ListWithContextFunc: func(ctx context.Context, opts metav1.ListOptions) (runtime.Object, error) {
			instance.With(&opts)
			list, err := client.List(ctx, opts)
			if err == nil {
				lastWorkflowProgress.WithLabelValues(role).SetToCurrentTime()
			}
			return list, err
		},
		WatchFuncWithContext: func(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
			instance.With(&opts)
			opts.AllowWatchBookmarks = true
			source, err := client.Watch(ctx, opts)
			if err != nil {
				return nil, err
			}
			return TrackWorkflowWatch(role, source), nil
		},
	}
}

// TrackWorkflowWatch records source progress without changing delivery or
// silently consuming bookmarks. The caller must still request bookmarks.
func TrackWorkflowWatch(role string, upstream watch.Interface) watch.Interface {
	w := &workflowWatch{upstream: upstream, stop: make(chan struct{}), out: make(chan watch.Event)}
	active := openWorkflowWatches.WithLabelValues(role)
	progress := lastWorkflowProgress.WithLabelValues(role)
	active.Inc()
	go func() {
		defer active.Dec()
		defer close(w.out)
		defer w.Stop()
		for {
			select {
			case <-w.stop:
				return
			case event, ok := <-upstream.ResultChan():
				if !ok {
					return
				}
				if event.Type != watch.Error {
					progress.SetToCurrentTime()
				}
				select {
				case w.out <- event:
				case <-w.stop:
					return
				}
			}
		}
	}()
	return w
}

type workflowWatch struct {
	upstream watch.Interface
	stop     chan struct{}
	out      chan watch.Event
	once     sync.Once
}

func (w *workflowWatch) Stop() {
	w.once.Do(func() {
		close(w.stop)
		w.upstream.Stop()
	})
}

func (w *workflowWatch) ResultChan() <-chan watch.Event { return w.out }
