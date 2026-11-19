# WorkflowTemplate examples for this fork

Each file is a standalone `kubectl apply` target for the `argo` namespace.
Most use the `wf-runner` service account, which needs `create,patch` on `workflowtaskresults` so the executor can finish a run; `run-action-demo.yaml` ships its own ServiceAccount and RBAC instead.
They assume client auth mode or SSO with RBAC, because the parameter-source endpoint returns 403 in server auth mode.
The submitting user still needs permission to submit from the template and, for Run actions, to read pod logs.

```yaml
apiVersion: v1
kind: ServiceAccount
metadata: {name: wf-runner, namespace: argo}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: {name: wf-runner, namespace: argo}
rules:
  - apiGroups: [argoproj.io]
    resources: [workflowtaskresults]
    verbs: [create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: {name: wf-runner, namespace: argo}
roleRef: {apiGroup: rbac.authorization.k8s.io, kind: Role, name: wf-runner}
subjects:
  - {kind: ServiceAccount, name: wf-runner, namespace: argo}
```

## Dynamic parameters

| File | What it shows |
| --- | --- |
| `dynamic-parameters-gist.yaml` | One gist document, two parameters reading different arrays through `itemsPath`, object items with `labelPath`/`valuePath`, plus one string-array source |
| `parameters-url-array.yaml` | The whole response is an array of strings: no `itemsPath`, `labelPath`, or `valuePath` |
| `parameters-url-dependent.yaml` | `{{team}}` in the URL with `dependsOn`, an `enum` parameter feeding a fetched one, values cleared on change |
| `parameters-configmap.yaml` | `configMap` source with `itemsPath`, read with the caller's RBAC, no host allowlist involved |
| `parameters-secret-header.yaml` | A header read from a Kubernetes Secret, using a public gist so no real credential is needed |

URL sources need their host in `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS`; the two gist-backed examples assume `gist.githubusercontent.com` is allowed.
ConfigMap and Secret sources need the caller to have `get` on that object in the run namespace.

## Run actions

| File | What it shows |
| --- | --- |
| `run-actions-link-only.yaml` | The smallest event: a link and a title, no `code` |
| `run-actions-renewed.yaml` | Two sequential requests with different ids, the shape a refreshed device code takes |
| `run-actions-expiry.yaml` | An expired request the UI ignores, then one that lapses after three minutes |
| `run-actions-sidecar.yaml` | `workflows-ui-action-container` pointing at a sidecar |
| `run-actions-unapproved-host.yaml` | A well-formed event for a host outside the allowlist, ignored with a warning |
| `device-login-run-action.yaml` | GitHub device flow: demo prompt without a client id, real token exchange with one |
| `run-action-demo.yaml` | Two fake requests 60 seconds apart on example.com, for UI testing only |

These need `github.com` in `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` (or `example.com` for the demo), pod egress to it, and permission to read pod logs.
Submit from the UI so the marker annotation is copied onto the Run.

## Fleet features

| File | What it shows |
| --- | --- |
| `runner-labels-gpu.yaml` | A `runsOn` requirement (the runner needs `--labels gpu`) and `spec.priority` ordering the queue |
| `job-concurrency-replace.yaml` | `workflows.argoproj.io/max-concurrent-runs` with `on-conflict: replace` |
| `approval-expiry.yaml` | A suspended step with approver scoping, an expiry, and approver notifications |
| `notifications-configmap.yaml` | Notification destinations (Slack, PagerDuty, webhook, SMTP), namespace defaults, runner health |

The runner examples use the [standalone broker and stock executor plugin](../docs/runner-broker.md).
Notification deliveries need their hosts in `ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS`.

## Running one

```bash
kubectl -n argo apply -f examples/parameters-url-dependent.yaml
# then Jobs -> parameters-url-dependent -> Run job
```

Workflow examples set `archiveLogs: false` so they do not depend on the cluster's artifact repository; remove that line where log archiving works.
