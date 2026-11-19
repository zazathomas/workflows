# Environment variables

Set these on the **argo-server Deployment**, never in the upstream controller's configuration ConfigMap: the controller rejects unknown fields in every [supported release](compatibility.md).

| Variable | Purpose |
| --- | --- |
| `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` | Comma-separated HTTPS hostnames allowed for [dynamic parameter sources](parameter-sources.md). Empty (default) disables URL sources. Entries with a scheme, port, wildcard, or trailing comma stop the server at startup. |
| `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` | Comma-separated exact DNS hostnames users may open from [Run actions](run-actions.md). Empty (default) offers no links. Malformed names stop the server. This policy grants no server egress. |
| `ARGO_SERVER_FORK_WORKER_NAMESPACE` | Run only the leader-elected fork worker for this workload namespace; no API or UI listener. Unset on argo-server API replicas. |
| `ARGO_SERVER_FORK_WORKER_METRICS_ADDRESS` | Optional private worker listener for Prometheus `/metrics`, for example `:9090`. Empty disables the listener. |
| `ARGO_SERVER_NOTIFICATION_NAMESPACE` | Enable the API's test-send route for one workload namespace with an installed notification worker. Empty disables test-send. |
| `ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS` | On the fork worker, comma-separated exact DNS hosts allowed for [notification](notifications.md) delivery. Empty disables notification processing. |
| `ARGO_SERVER_APPROVAL_NAMESPACE` | Namespace served by [approvals](approvals.md). Set the same namespace on the API and the fork worker. Empty disables approvals on that process. Install the namespace-scoped decision-record RBAC first. |
| `ARGO_SERVER_APPROVAL_AUTO_APPROVE` | On the worker, set `true` to enable Job-configured approval wait timers. Off by default. |
| `IP_KEY_FUNC_HEADERS` | Header names used for HTTP rate-limit keys, for the API limiter. The deployment examples use `X-Forwarded-For`; only enable it behind an ingress that overwrites the header. |

All other argo-server runtime variables keep their upstream meaning; see [upstream's reference](https://argo-workflows.readthedocs.io/en/latest/environment-variables/).

## argo-runner

The runner binary (`argo-runner`, see [runners.md](runners.md)) reads these; flags take precedence.

| Variable | Purpose |
| --- | --- |
| `ARGO_RUNNER_SERVER` | Broker HTTPS origin for enrollment; set this explicitly. |
| `ARGO_RUNNER_JOIN_TOKEN` | Single-use join token; `run` also enrols a fresh host on first start when it is set. Drop it afterwards. |
| `ARGO_RUNNER_LABELS` | Capability labels for enrolment (comma-separated, such as `gpu,arm64`), matched by template `runsOn` requirements. |
| `ARGO_RUNNER_ATTESTATION` | Attestation type for pools that require it (`aws-iid`). |
| `ARGO_RUNNER_CREDENTIALS_DIR` | Credentials directory, created `0700`; default `/etc/argo-runner` (the containerised runner image sets `/home/rootless/argo-runner`). |
| `ARGO_RUNNER_POLICY` | Runner-local policy file; default `/etc/argo-runner/policy.json`. |
| `ARGO_RUNNER_INSECURE_SKIP_TLS_VERIFY` | `true` skips the server certificate check for self-signed servers; the transport is then open to interception. Prefer distributing the certificate. |
| `ARGO_RUNNER_GATE_LISTEN`, `ARGO_RUNNER_GATE_KEY` | Gate listen address (default `127.0.0.1:8081`) and signing-key path (default `/etc/argo-runner/gate-key`). |
| `DIND_MODE` | Containerised runner flavour: `rootless` (default), `privileged`, or `sysbox`. |
| `DOCKER_HOST` | Docker daemon for the native runner flavour. |

## Standalone runner broker and plugin

| Variable | Purpose |
| --- | --- |
| `BROKER_DATABASE_URL` | PostgreSQL DSN for the broker and its operator commands. Do not share it with workers or the plugin. |
| `BROKER_NAMESPACE`, `BROKER_POOL` | The single namespace and pool served by this broker Deployment. |
| `BROKER_CONCURRENCY` | Maximum simultaneous job attempts per pool, default 8. Use the same value on every replica. |
| `BROKER_PLUGIN_TOKEN_FILE` | File containing the bearer credential for plugin requests. |
| `BROKER_PLUGIN_TOKEN` | Plugin-only fallback when the stock agent's sidecar can inject the credential as an environment variable but cannot add a volume. |
| `BROKER_URL` | HTTPS origin the plugin calls; use a certificate trusted by the plugin container. |
| `BROKER_CA_PEM` | Optional private CA PEM for the plugin's HTTPS client. |
| `BROKER_TLS_CERT`, `BROKER_TLS_KEY` | TLS certificate and key paths for the broker HTTPS listener. |
| `BROKER_TEST_DATABASE_URL` | Disposable PostgreSQL DSN for broker integration tests. |

## Test and build scripts

Used by the conformance and UI scripts, not by the server.

| Variable | Purpose |
| --- | --- |
| `ARGO_CONFORMANCE_NAMESPACE` | Namespace for the disposable live conformance scripts; default `argo`. |
| `ARGO_CONFORMANCE_PORT` | Local port forwarded to the disposable argo-server; a free port by default. |
| `ARGO_CONFORMANCE_VERSION` | Release name used in conformance output; `conformance-version.sh` sets it. |
| `ARGO_CONFORMANCE_ACTION_ALLOW_HOSTS` | Optional hostname expected in the disposable server's run-action policy. |
| `KEEP`, `KIND` | Keep the kind cluster after a failure (`1`), and the `kind` binary path. |
| `ARGO_UI_BASE_URL` | UI address used by Playwright; default `http://localhost:8080`. |
| `PLAYWRIGHT_BROWSER_PATH` | Browser executable used by the mock-backed Playwright suite. |
| `VERSION`, `GIT_COMMIT`, `GIT_TAG`, `GIT_TREE_STATE`, `BUILD_DATE` | Build metadata passed by the image release workflow. |
