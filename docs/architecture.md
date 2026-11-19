# workflows architecture

This repository builds `argo server` and embeds the React UI in its binary.
The image contains no workflow controller or `argoexec`: install an upstream controller, executor images, and CRDs from a [supported release](compatibility.md) separately.
The server talks to Kubernetes with its service account for caches and, in client auth mode, with the caller's credentials for API operations.

`server/apiserver` serves the upstream gRPC and HTTP APIs, the artifact routes, and the embedded UI on port 2746.

## Fork extensions

The parameter, environment, approval, notification test-send, and runner admin endpoints are refused in server auth mode and in SSO without RBAC, because they act with the caller's own Kubernetes identity; the run-action host policy is readable in every mode and reveals no caller data.

- `server/parameter` ([parameter sources](parameter-sources.md)): reads a `workflows.argoproj.io/parameter-sources` annotation from a template the caller can read, then fetches an allowlisted HTTPS endpoint, a ConfigMap, or a value from a Secret header.
- `server/environment` ([environment viewer](environment-viewer.md)): pages through Kubernetes metadata with the caller's RBAC and reads key names and sizes only on demand.
- `server/workflow/run_view.go`: authorizes before reading the workflow cache, returns paginated summaries and gates, and exposes an exact gate count for each complete cache snapshot.
- The Runs list applies name/title and label substring filters on the server, before paging the live and archived results; matching treats `%` and `_` as literal characters.
  The browser refreshes the matching page instead of merging an unfiltered watch.
- `server/approvals` ([approvals](approvals.md)): authorizes dedicated decide grants, reserves immutable Kubernetes decision records, and reconciles suspended gates and expiry in the configured workflow namespace.
- `server/notify` ([notifications](notifications.md)): delivers run events to destinations defined in a namespace `argo-notifications` ConfigMap and audits each delivery as an Event.
- [`runner/broker`](runner-broker.md) serves enrolled workers and the stock Argo executor plugin over HTTPS.
  PostgreSQL stores queue and claim state; argo-server does not participate in remote dispatch.
- `server/runaction` exposes the approved link hosts to authenticated UI clients; `ui/src/run-actions` watches workflow and pod-log streams for opted-in runs while the browser is open. Run actions add no CRD or generated API field.
- `workflow/common` and `server/workflow/job_concurrency.go` copy Job control annotations onto the submitted run and inject the mutex behind [per-job concurrency](job-concurrency.md).

The [fork worker](deployment.md#fork-worker) elects one leader per namespace and shares a Workflow informer across approval timers and notifications.
API replicas enqueue fork records; only the worker applies gate decisions and delivers notifications.
Neither role requires changes to the upstream controller, executor or CRDs.

The UI changes Argo names only on screen: a Job is a WorkflowTemplate or ClusterWorkflowTemplate, a Run is a Workflow.
The Job and Schedule **Changes** tabs read `metadata.managedFields`; argo-server's template informers keep the audit fields (manager, operation, time) and strip the per-field sets, which the controller drops entirely.
The Logs panel hides executor log lines by default (`ui/src/workflows/components/workflow-logs-viewer`), without changing the log API.

`hack/upstream-versions.json` lists the upstream releases this image is tested against, and the compatibility workflow runs that matrix.

For workflow execution and controller internals, use the [upstream documentation](https://argo-workflows.readthedocs.io/en/latest/).
