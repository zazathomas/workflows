# Environment variables

workflows uses these server runtime variables for its extensions and deployment:

| Variable | Purpose |
| --- | --- |
| `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` | Comma-separated HTTPS hostnames allowed for dynamic parameter sources. Empty by default, which disables URL sources. The server rejects other hostnames and nonstandard HTTPS ports, and refuses to start when an entry is malformed (scheme, port, wildcard, or trailing comma). |
| `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` | Comma-separated exact DNS hostnames that users may open from run actions. Empty by default, so no run-action links are offered. The server rejects malformed names at startup. This policy does not grant server network egress. |
| `IP_KEY_FUNC_HEADERS` | Header names used for HTTP rate-limit keys. The deployment examples use `X-Forwarded-For`; only enable that setting behind an ingress that overwrites the header. |

Set these variables on the `argo-server` Deployment, not the upstream controller configuration ConfigMap; the controller rejects unknown configuration fields in every [supported release](compatibility.md).
All other Argo Server runtime variables retain their upstream meaning; consult [upstream's environment variable reference](https://argo-workflows.readthedocs.io/en/latest/environment-variables/).

The fork's test and build scripts accept these optional variables:

| Variable | Purpose |
| --- | --- |
| `ARGO_CONFORMANCE_NAMESPACE` | Namespace for the disposable live conformance scripts; default `argo`. |
| `ARGO_CONFORMANCE_PORT` | Local port forwarded to the disposable Argo Server; a free port by default. |
| `ARGO_CONFORMANCE_VERSION` | Release name used in conformance output; `conformance-version.sh` sets it. |
| `ARGO_CONFORMANCE_ACTION_ALLOW_HOSTS` | Optional hostname expected in the disposable server's run-action policy during conformance. |
| `KEEP` | Set to `1` so `conformance-version.sh` keeps its kind cluster after a failure. |
| `KIND` | Path to the `kind` binary used by `conformance-version.sh`. |
| `ARGO_UI_BASE_URL` | UI address used by Playwright; default `http://localhost:8080`. |
| `PLAYWRIGHT_BROWSER_PATH` | Browser executable used by mock-backed Playwright tests. |
| `VERSION`, `GIT_COMMIT`, `GIT_TAG`, `GIT_TREE_STATE`, `BUILD_DATE` | Build metadata passed by the image release workflow. |
