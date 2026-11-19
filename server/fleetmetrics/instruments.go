// Package fleetmetrics holds the event-driven fleet metric instruments shared
// by the runner dispatcher and the notification controller: the
// claim-to-start wait histogram the dispatcher observes when a runner claims a
// job, and the notification delivery counter. The state gauges (queue depth,
// jobs, runner health, concurrency headroom) are scraped from live state by
// the runner package's collector on each /metrics scrape.
//
// Everything is registered on the default Prometheus registry, which the
// /metrics endpoint of argo-server serves.
package fleetmetrics

import (
	"github.com/prometheus/client_golang/prometheus"
)

// Instruments are the event-driven fleet metrics. A nil *Instruments is valid
// and inert, so callers that run without metrics (tests, the dispatcher in
// isolation) need no special cases.
type Instruments struct {
	// ClaimWaitSeconds is observed by the dispatcher when a runner claims a
	// job, with the time the task spent queued (first index entry to the
	// claim), by pool. The wait is per pool: it is what an operator can alert
	// on when a pool is saturated (docs/fleet-metrics.md).
	ClaimWaitSeconds *prometheus.HistogramVec
	// NotifyDeliveries counts notification deliveries by trigger, transport
	// and outcome (delivered, error, suppressed).
	NotifyDeliveries *prometheus.CounterVec
	NotifyPending    prometheus.Gauge
	NotifyOldestAge  prometheus.Gauge
}

// NewInstruments creates and registers the instruments on reg. Call it once
// per process; argo-server registers them on the default registry so
// /metrics serves them.
func NewInstruments(reg prometheus.Registerer) *Instruments {
	i := &Instruments{
		ClaimWaitSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{
			Namespace: "argo",
			Subsystem: "runner",
			Name:      "claim_wait_seconds",
			Help:      "Seconds a runner task waited in the queue before a runner claimed it, by pool.",
			// Waits range from instant (idle pool) to hours (saturated pool);
			// exponential buckets from 250ms to ~17 minutes cover both.
			Buckets: prometheus.ExponentialBuckets(0.25, 2, 14),
		}, []string{"pool"}),
		NotifyDeliveries: prometheus.NewCounterVec(prometheus.CounterOpts{
			Namespace: "argo",
			Name:      "notify_deliveries_total",
			Help:      "Notification deliveries by trigger, transport and outcome.",
		}, []string{"trigger", "transport", "outcome"}),
		NotifyPending:   prometheus.NewGauge(prometheus.GaugeOpts{Name: "argo_notify_outbox_pending", Help: "Pending notification records seen by the last outbox scan."}),
		NotifyOldestAge: prometheus.NewGauge(prometheus.GaugeOpts{Name: "argo_notify_outbox_oldest_seconds", Help: "Age in seconds of the oldest pending notification seen by the last outbox scan."}),
	}
	reg.MustRegister(i.ClaimWaitSeconds, i.NotifyDeliveries, i.NotifyPending, i.NotifyOldestAge)
	return i
}

// ObserveClaimWait records the wait of a claimed task. A nil receiver is a
// no-op.
func (i *Instruments) ObserveClaimWait(poolLabel string, wait float64) {
	if i == nil || i.ClaimWaitSeconds == nil {
		return
	}
	i.ClaimWaitSeconds.WithLabelValues(poolLabel).Observe(wait)
}

// CountDelivery records one notification delivery outcome. A nil receiver is
// a no-op.
func (i *Instruments) CountDelivery(trigger, transport, outcome string) {
	if i == nil || i.NotifyDeliveries == nil {
		return
	}
	i.NotifyDeliveries.WithLabelValues(trigger, transport, outcome).Inc()
}
