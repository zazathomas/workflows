# Notification metrics

Set `ARGO_SERVER_FORK_WORKER_METRICS_ADDRESS` to expose `argo_notify_deliveries_total` on the worker's private `/metrics` endpoint, with `trigger`, `transport`, and `outcome` labels.
Restrict access to your Prometheus scraper; the listener is not authenticated.
Outcomes include `delivered`, `error`, and `suppressed`.
The worker also exposes `argo_notify_outbox_pending` and `argo_notify_outbox_oldest_seconds` from its last completed scan.
The API server exports `argo_fork_run_view_duration_seconds` for authorized summary, gate, and count reads.
The API and worker export `argo_fork_workflow_informer_open_watches` and `argo_fork_workflow_informer_last_progress_timestamp_seconds`, labeled by `role`.
The timestamp advances after a successful list, watch event, or bookmark.
An idle watch may have no recent events, so use the timestamp alongside the open-stream gauge; neither measures when a particular workflow was last reconciled.
Only the elected worker opens the workflow watch.
Runner state now lives in the [standalone broker](runner-broker.md); the old argo-server runner gauges and alerts are no longer available.

```promql
increase(argo_notify_deliveries_total{outcome="error"}[30m]) > 0
```
