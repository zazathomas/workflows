# WorkflowTemplate examples for this fork

Each file is a standalone `kubectl apply` target for the `argo` namespace and uses
the `wf-runner` service account, which already has `create,patch` on
`workflowtaskresults` in this cluster.
They assume the server is running in client auth mode, or SSO with RBAC, because
the parameter-source endpoint returns 403 in server auth mode.

## Dynamic parameters

| File | What it shows |
| --- | --- |
| `dynamic-parameters-gist.yaml` | One gist document, two parameters read different arrays through `itemsPath`, object items with `labelPath`/`valuePath`, plus one string-array source |
| `parameters-url-array.yaml` | The whole response is an array of strings: no `itemsPath`, `labelPath` or `valuePath` |
| `parameters-url-dependent.yaml` | `{{team}}` in the URL with `dependsOn`, an `enum` parameter feeding a fetched one, and dependent values clearing on change |
| `parameters-configmap.yaml` | `configMap` source with `itemsPath`, read with the caller's RBAC and no host allowlist involved |
| `parameters-secret-header.yaml` | A header read from a Kubernetes Secret, using a public gist so no real credential is needed |

URL sources need their host in `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS`; this
cluster allows `gist.githubusercontent.com`. ConfigMap and Secret sources instead
need the caller to have `get` on that object in the run namespace.

## Run actions

| File | What it shows |
| --- | --- |
| `run-actions-link-only.yaml` | The smallest event: a link and a title, no `code` |
| `run-actions-renewed.yaml` | Two sequential requests with different ids, the shape a refreshed device code takes |
| `run-actions-expiry.yaml` | An expired request the UI ignores, then one that lapses after three minutes |
| `run-actions-sidecar.yaml` | `workflows-ui-action-container` pointing at a sidecar rather than `main` |
| `run-actions-unapproved-host.yaml` | A well-formed event for a host outside the allowlist, ignored with a warning |
| `device-login-run-action.yaml` | GitHub device flow: demo prompt without a client id, real token exchange and login when one is supplied |
| `run-action-demo.yaml` | Two fake requests 60 seconds apart, using example.com, for UI testing only |

Events need `github.com` in `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS`, pod egress to it,
and the user needs permission to read pod logs. Submit from the UI so the marker
annotation is copied onto the Run; a Run created with `kubectl` is not monitored
unless you add `workflows-ui-action-marker` and `workflows-ui-action-container`
annotations yourself.

## Running one

```bash
kubectl -n argo apply -f examples/parameters-url-dependent.yaml
# then Jobs -> parameters-url-dependent -> Run job
```

Every example sets `archiveLogs: false` so it does not depend on the cluster's
artifact repository. Remove that line where log archiving works.
