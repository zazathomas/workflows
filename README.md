# workflows

workflows is an opinionated server and web UI fork of [Argo Workflows](https://github.com/argoproj/argo-workflows).
It ships the gRPC/HTTP API and embedded React UI as one container for submitting,
running, and monitoring jobs. Workflow execution still needs an upstream controller,
executor, and CRDs. The Argo Workflows API and Kubernetes resources keep their names.

## What's included

- **Server** — `argo server`, the Argo Workflows API over gRPC and HTTP, with the web UI
  embedded in the same binary.
- **Web UI** — a React app for submitting and managing workflows, workflow templates,
  cron workflows, and the archive. Includes a guided submit wizard, workflow DAG and
  timeline views, logs, reports, dark mode, and opt-in Run actions for browser-based sign-in.
- **Local mock server** — `hack/mock-argo-server.py` serves a small in-memory Argo API so
  the UI can be run and tested without a Kubernetes cluster.
- **Go sources** — the upstream server and required shared packages are retained;
  fork changes are limited to the server extensions (parameter sources, Run actions),
  the authentication guard, log filtering, and the UI.

## UI terminology and Argo Workflows

The UI uses job-runner terminology so a team can find a reusable definition under
**Jobs**, start it, and follow each execution under **Runs**. This keeps the definition
and its execution distinct in the interface. It does not change Argo's resources,
permissions, API, CLI, or existing URLs.

| UI term | Argo Workflows resource | Meaning |
| --- | --- | --- |
| Job | `WorkflowTemplate` or `ClusterWorkflowTemplate` | A reusable workflow definition. A WorkflowTemplate is namespaced; a ClusterWorkflowTemplate is cluster-scoped. |
| Run | `Workflow` | One execution, with its own status, parameters, logs, and outputs. A Workflow can also be submitted without a template. |
| Schedule | `CronWorkflow` | A schedule that creates Workflow runs. |
| Step or graph node | Workflow node, such as a DAG task or step | A part of a run shown in the graph and timeline. |
| Namespace | Kubernetes namespace | The scope for namespaced templates and workflow runs. |

See [the glossary](GLOSSARY.md) for the same terms outside the UI.

Cluster-scoped templates can be used across namespaces where the user has the
appropriate permissions. “Job” here means a reusable Argo workflow template, not a
Kubernetes `Job` resource. Advanced views retain Argo terminology where it helps
when working with manifests or API responses.

## Prerequisites

- Go (see the version in `go.mod`)
- Node.js >= 20 and Yarn (for the UI)
- An upstream Argo Workflows controller, executor image, and CRDs from a [supported release](docs/compatibility.md) for live workflow execution

## Build

```bash
make cli    # builds dist/argo (includes `argo server`)
```

## Run

```bash
# Serve the API + UI against a Kubernetes cluster
./dist/argo server
```

```bash
# Run the UI without a cluster, using the mock API
python3 hack/mock-argo-server.py   # mock API on http://127.0.0.1:2746
yarn --cwd ui start                # UI on http://localhost:8080 (proxies /api to :2746)
```

## Test

```bash
make upstream-versions       # fetch the supported upstream release tags once
make compatibility           # API contract for every supported release plus server/CLI tests
make test-hack               # compatibility tooling unit tests
make test-ui                 # UI unit tests (Jest)
make test-ui-e2e             # mock-backed UI tests (start the dev server first)
```

## Deployment and support

The production image is built from `Dockerfile` and published as `ghcr.io/zazathomas/workflows`
by a protected `x.y.z` release tag after image scanning and cluster-backed conformance across every [supported upstream release](docs/compatibility.md).
See the [deployment guide](docs/deployment.md) for replacing the Helm- or manifest-installed server, the [compatibility policy](docs/compatibility.md),
[parameter source guide](docs/parameter-sources.md), [run actions](docs/run-actions.md), and [security policy](SECURITY.md).
The container does not include a workflow controller or executor.

## License

Apache 2.0. See [LICENSE](LICENSE). This is a fork of
[Argo Workflows](https://github.com/argoproj/argo-workflows), a Cloud Native Computing
Foundation graduated project.
