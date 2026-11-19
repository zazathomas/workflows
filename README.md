# workflows

An opinionated server and web UI fork of [Argo Workflows](https://github.com/argoproj/argo-workflows).
The fork ships the Argo gRPC and HTTP API plus an embedded React UI in one container.
Workflow execution still uses the upstream controller, executor, and CRDs from a [supported release](docs/compatibility.md).
Argo resource names, permissions, APIs, CLI commands, and URLs remain compatible with upstream.

## Contents

- [What this fork adds](#what-this-fork-adds)
- [UI terminology](#ui-terminology)
- [Quickstart](#quickstart)
  - [Prerequisites](#prerequisites)
  - [Deploy the fork server](#deploy-the-fork-server)
  - [Verify the installation](#verify-the-installation)
  - [Try dynamic parameters](#try-dynamic-parameters)
  - [Try Run actions](#try-run-actions)
  - [Enable approvals](#enable-approvals)
  - [Enable notifications](#enable-notifications)
  - [Set per-Job concurrency](#set-per-job-concurrency)
  - [Run a remote step](#run-a-remote-step)
- [Examples](#examples)
- [Local development](#local-development)
- [Compatibility and security](#compatibility-and-security)
- [Documentation](#documentation)
- [License](#license)

## What this fork adds

### Dynamic parameter sources

The submit form can populate selectors from HTTPS JSON endpoints or ConfigMaps.
Sources can depend on earlier selections, and HTTP requests can use a header read from a Secret.
The server validates the source, applies an administrator allowlist, and submits only the selected values.

See [dynamic parameter sources](docs/parameter-sources.md).

### Run actions

A running workflow can display an approved browser link for tasks such as device-code sign-in.
A pod emits a marked JSON event in its logs, and the UI shows the link and optional code while the run is active.
The server restricts links to administrator-approved HTTPS hosts.

See [Run actions](docs/run-actions.md).

### Approvals

The fork adds an Approvals page and API for suspended workflow steps.
Approvers can receive dedicated RBAC permissions, restrictions, expiry handling, and immutable decision records.
A separate fork worker reconciles decisions and can deliver approval notifications.
Admission policies are available when a suspended step must protect a release gate.

Upstream provides suspend steps, while this fork adds the approval inbox and decision workflow around them.

See [approvals](docs/approvals.md).

### Notifications

Runs can notify Slack, PagerDuty, HTTPS webhooks, or SMTP when they start, finish, fail, suspend, wait, or exceed a configured duration.
A namespace ConfigMap defines destinations, and the worker persists delivery records, retries failures, and exposes Prometheus metrics.

Upstream commonly uses exit handlers or an external notification service for this work.

See [notifications](docs/notifications.md) and [notification metrics](docs/fleet-metrics.md).

### Environment viewer

The UI can list ConfigMaps and Secrets using the caller's Kubernetes permissions.
It shows object names, key names, sizes, and immutability without returning Secret values to the browser.

See [the environment viewer](docs/environment-viewer.md).

### Per-Job concurrency

Job annotations can add a mutex or semaphore when a run is submitted.
The fork supports `queue`, `replace`, and `reject` behavior when another run is active.

```yaml
metadata:
  annotations:
    workflows.argoproj.io/max-concurrent-runs: "1"
    workflows.argoproj.io/on-conflict: queue
```

See [per-Job concurrency](docs/job-concurrency.md).

### Remote Linux runners

The standalone runner broker lets one workflow combine Kubernetes steps with steps executed on remote Linux hosts.
It provides PostgreSQL-backed queue state, runner pools and labels, signed enrollment, lease recovery, and runner-local security policies.

See [the runner broker](docs/runner-broker.md) and [runner operations](docs/runners.md).

### Enhanced UI

The embedded UI adds Jobs and Runs terminology, saved views, run comparison, timelines, reports, keyboard shortcuts, dark mode, managed-field history, approval workflows, environment inventory, and Run action prompts.

## UI terminology

The UI uses job-runner terminology so users can find a reusable definition under **Jobs**, start it, and follow each execution under **Runs**.
The underlying Argo resource names and APIs do not change.

| UI term | Argo resource | Meaning |
| --- | --- | --- |
| Job | `WorkflowTemplate` or `ClusterWorkflowTemplate` | A reusable workflow definition. |
| Run | `Workflow` | One execution with its own status, parameters, logs, and outputs. |
| Schedule | `CronWorkflow` | A schedule that creates workflow runs. |
| Step or graph node | Workflow node | A part of a run shown in the graph and timeline. |
| Namespace | Kubernetes namespace | The scope for namespaced templates and runs. |

In this UI, Job means a reusable Argo workflow template, not a Kubernetes `Job` resource.
See the [glossary](GLOSSARY.md) for the same terms outside the UI.

## Quickstart

### Prerequisites

You need a Kubernetes cluster with an upstream Argo Workflows installation.
Use a controller, executor image, and CRDs from one release listed in the [compatibility matrix](docs/compatibility.md).
The examples in this repository target the `argo` namespace unless a file says otherwise.

Use client authentication or SSO with RBAC for fork extensions that act with the caller's Kubernetes identity.
Do not expose server authentication mode to untrusted users because it uses the server's service-account permissions.

### Deploy the fork server

Install the upstream controller, executor, CRDs, and server using your normal upstream method.
Then replace only the `argo-server` image with a digest-pinned image from this fork.

For Helm, start with the existing values and the repository's server override:

```bash
helm get values RELEASE -n argo -o yaml > /tmp/argo-values.before.yaml
helm template RELEASE argo/argo-workflows --version 2.0.14 -n argo \
  -f /tmp/argo-values.before.yaml \
  -f deploy/helm-server-values.yaml > /tmp/argo-preview.yaml
helm upgrade RELEASE argo/argo-workflows --version 2.0.14 -n argo \
  --reuse-values -f deploy/helm-server-values.yaml --atomic --timeout 10m
```

Keep the upstream controller image, executor image, and CRDs unchanged.
The chart version above matches upstream Argo Workflows `v4.1.6`; choose the chart listed for your installed release.

Add allowlists only for the extensions you use, and set them on the `argo-server` Deployment:

```yaml
env:
  - name: ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS
    value: "catalog.example.com"
  - name: ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS
    value: "github.com,login.microsoftonline.com"
```

Use exact hostnames without schemes, ports, wildcards, or trailing commas.
Parameter-source and Run-action allowlists control different features.

For a manifest-based installation, render and apply `deploy/manifests` as described in the [deployment guide](docs/deployment.md).

### Verify the installation

```bash
kubectl -n argo rollout status deployment/argo-server --timeout=10m
kubectl -n argo get pods
```

Open the server URL and verify that the UI loads, authentication works, a Job can be submitted, and a Run reaches `Succeeded`.
The readiness probe only verifies that the server process answers; it does not verify the controller, database, or artifact store.

### Try dynamic parameters

Apply the dependent-parameter example:

```bash
kubectl -n argo apply -f examples/parameters-url-dependent.yaml
```

In the UI, open **Jobs**, select `parameters-url-dependent`, choose a team, and then choose the dynamically loaded environment.

For a ConfigMap-backed source, apply:

```bash
kubectl -n argo apply -f examples/parameters-configmap.yaml
```

URL sources require the endpoint hostname in `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS`.
ConfigMap sources do not need a hostname allowlist, but the caller needs permission to read the ConfigMap.

### Try Run actions

Use the synthetic demo on a disposable installation:

```bash
kubectl -n argo set env deployment/argo-server \
  ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=example.com
kubectl -n argo rollout status deployment/argo-server
kubectl -n argo apply -f examples/run-action-demo.yaml
```

Open **Jobs**, select `run-action-demo`, and choose **Run job**.
The UI displays fake browser-action requests from the running workflow.
The demo does not perform authentication and should not be used with real credentials.

Clean up the demo with:

```bash
kubectl -n argo delete workflows -l workflows.argoproj.io/workflow-template=run-action-demo
kubectl -n argo delete -f examples/run-action-demo.yaml
```

### Enable approvals

Deploy the fork worker and its namespace-scoped RBAC from [`deploy/fork-worker/worker.yaml`](deploy/fork-worker/worker.yaml).
Set `ARGO_SERVER_APPROVAL_NAMESPACE` to the workflow namespace on both the API and worker deployments.
Grant approvers the virtual `platform.argoproj.io/workflowapprovals` `decide` permission.

Apply the example:

```bash
kubectl -n argo apply -f examples/approval-expiry.yaml
```

Open the **Approvals** page to approve or reject the suspended step.

Install the guarded admission policy from [`deploy/approvals/protected-namespace.yaml`](deploy/approvals/protected-namespace.yaml) before using approvals as a release authorization boundary.
Without that policy and restrictive RBAC, a suspended step is a workflow convenience rather than a protected release gate.

### Enable notifications

Apply the example destination ConfigMap and replace its placeholder credentials:

```bash
kubectl -n argo apply -f examples/notifications-configmap.yaml
```

Annotate a Job with destinations and triggers:

```yaml
metadata:
  annotations:
    notifications.argoproj.io/destinations: team-slack
    notifications.argoproj.io/triggers: started,succeeded,failed,suspended
```

Set `ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS` on the fork worker, not on the upstream controller.
Credential Secrets must carry the `notifications.argoproj.io/allowed: "true"` label.

Use client authentication or SSO with RBAC for the notification test-send endpoint.
See [notifications](docs/notifications.md) for the worker deployment, RBAC, egress policy, retries, and supported transports.

### Set per-Job concurrency

Add the annotations below to a WorkflowTemplate, ClusterWorkflowTemplate, or CronWorkflow:

```yaml
metadata:
  annotations:
    workflows.argoproj.io/max-concurrent-runs: "1"
    workflows.argoproj.io/on-conflict: replace
```

`queue` is the default and waits for the synchronization lock.
`replace` creates the new run and attempts to stop older runs.
`reject` checks for an active run before submission, although the check is not atomic across concurrent submissions.

For a limit greater than one, create the administrator-owned `argo-job-concurrency` ConfigMap described in [per-Job concurrency](docs/job-concurrency.md).

### Run a remote step

Remote execution requires the standalone broker, PostgreSQL, the stock Argo executor plugin, and an enrolled Linux runner.
Follow [the broker installation guide](docs/runner-broker.md) to configure TLS, enrollment, plugin credentials, and the worker pool.

Then submit the mixed workflow:

```bash
kubectl -n builds apply -f examples/mixed-runner-broker.yaml
```

The example runs a Kubernetes step, a remote Linux step, and a final Kubernetes validation step.
Use dedicated or disposable runners when workflows cross trust boundaries.

## Examples

The [`examples/`](examples/README.md) directory contains runnable examples for:

- Dynamic URL, ConfigMap, and Secret-backed parameters.
- Dependent parameter selectors.
- Run actions, expiry, renewal, sidecars, and GitHub device flow.
- Approval expiry and approver scoping.
- Notifications and namespace defaults.
- Per-Job concurrency replacement.
- Runner labels, priorities, and mixed Kubernetes and remote execution.

Each example documents its expected namespace, service account, RBAC, and security assumptions.

## Local development

The project runs builds, tests, and UI tooling in containers.
The complete workflow is in [docs/running-locally.md](docs/running-locally.md).

Build the UI and server with the pinned container images:

```bash
docker run --rm -v "$PWD":/src \
  -v workflows-ui-nm:/src/ui/node_modules -w /src \
  node:24-alpine3.23 sh -c \
  'apk add git && yarn --cwd ui install --frozen-lockfile && yarn --cwd ui build'

docker run --rm -v "$PWD":/src \
  -v workflows-go-mod:/go/pkg/mod -w /src \
  golang:1.27.3-alpine3.23 sh -c \
  'apk add git make ca-certificates bash && make dist/argo'
```

Run the resulting server inside the documented Go container workflow and expose port `2746`.

For UI-only work, start the mock API and UI inside containers as described in [docs/running-locally.md](docs/running-locally.md).
The mock API does not execute real workflows.

Useful checks include:

```bash
make upstream-versions
make test
make test-ui-e2e
make lint
```

Run these targets through the documented container workflow rather than installing project toolchains on the host.

## Compatibility and security

The current compatibility matrix covers upstream Argo Workflows `v4.1.0` through `v4.1.6`.
The controller, executor image, and CRDs must come from the same upstream release.

Review [deployment](docs/deployment.md), [compatibility](docs/compatibility.md), and [fork security](docs/fork-security.md) before production use.
Pin images by digest and configure TLS, ingress access controls, RBAC, network policies, and resource limits for your environment.

## Documentation

- [Architecture](docs/architecture.md)
- [Deployment](docs/deployment.md)
- [Compatibility policy](docs/compatibility.md)
- [Environment variables](docs/environment-variables.md)
- [Dynamic parameter sources](docs/parameter-sources.md)
- [Run actions](docs/run-actions.md)
- [Approvals](docs/approvals.md)
- [Notifications](docs/notifications.md)
- [Per-Job concurrency](docs/job-concurrency.md)
- [Environment viewer](docs/environment-viewer.md)
- [Runner broker](docs/runner-broker.md)
- [Remote runner operations](docs/runners.md)
- [Runner threat model](docs/runner-threat-model.md)
- [Notification metrics](docs/fleet-metrics.md)
- [Local development](docs/running-locally.md)
- [Security guidance](docs/fork-security.md)

For workflow syntax, controller behavior, executor behavior, and Kubernetes resource reference, use the [upstream Argo Workflows documentation](https://argo-workflows.readthedocs.io/en/latest/).

## License

Apache 2.0.
See [LICENSE](LICENSE).
This project is a fork of [Argo Workflows](https://github.com/argoproj/argo-workflows), a Cloud Native Computing Foundation graduated project.
