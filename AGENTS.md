# workflows

Server and UI fork of Argo Workflows, a Kubernetes-native workflow engine: workflows are CRDs, each step runs as a container. Components: `workflow-controller` (reconciles Workflows into pods), `argo-server` (gRPC+HTTP API, hosted inside the `argo` CLI binary), `argoexec` (runs inside workflow pods), and a React UI. Go module `github.com/argoproj/argo-workflows/v4` (imports need `/v4`); release builds use Go modules, not a vendored directory.

Per-directory guidance lives in `ui/AGENTS.md` and `docs/AGENTS.md`. Read the relevant one before working in those areas.

## Commands

- Build: `make cli` (`dist/argo`, which includes `argo server`).
- Server and API tests: `make compatibility` checks the API contract for every release in `hack/upstream-versions.json` and runs focused packages. `make test-hack` covers the compatibility tooling. For direct local tests, set `GOFLAGS='-mod=mod -tags=kubernetes_protomessage_one_more_release'` if an ignored `vendor/` directory is present.
- Mock-backed UI tests: start the UI development server, then run `yarn --cwd ui playwright test -c playwright.mock.config.ts`.
- Live testing requires an existing Argo Workflows installation. The upstream Tilt stack and its controller/executor build targets are not supported by this fork; see `docs/running-locally.md`.
- Lint: `make lint` (UI ESLint and TypeScript checks). Documentation lives as Markdown in `docs/`; no docs site is published.
- Upstream releases: `make upstream-versions` fetches the tags in `hack/upstream-versions.json`; `make upstream-contract` then compares the API contract for each of them.
- Deployment sources: `deploy/helm-server-values.yaml` for a Helm release, `deploy/manifests/` for a Kustomize render of the upstream release asset; see `docs/deployment.md`.
- Release: a protected `x.y.z` tag, such as `4.1.6`, runs the multi-release compatibility matrix, then image scan and publish; see `docs/release.md`.

## Conventions

- Commits and reviews: use Conventional Commits, run `make compatibility` and UI tests, and include tests for behavior changes.
- Logging is the repo's own `util/logging`, not logrus: level methods take ctx (`logger.Info(ctx, "msg")`); get the logger with `logging.RequireLoggerFromContext(ctx)`; tests use `logging.TestContext(t.Context())`.
- Errors: `errors/` for coded, user-visible `ArgoError`s; `util/errors.IsTransientErr(ctx, err)` for retry decisions.
- Document environment variables read via `os.Getenv`/`util/env` in `docs/environment-variables.md`.

### Generated files

Do not hand-edit generated API clients, protobufs, schemas or generated documentation. The upstream code generation pipeline is not included in this minimal fork; changes requiring regeneration need a compatible upstream checkout.

## Architecture

Entrypoint: `cmd/argo` → `cmd/argo/commands/` (includes `argo server` → `server/`). The fork connects to an existing controller and does not contain controller or executor implementations; `workflow/controller/informer` remains shared server code.

Cross-cutting invariants: the executor never writes the Workflow object — outputs travel through `WorkflowTaskResult` CRs merged by the controller. Large node status is compressed and, if still too big, offloaded to SQL (`workflow/hydrator/`, `persist/sqldb/`) — any reader outside the controller must hydrate first.

### Server (`server/`)

`server/apiserver` serves gRPC and grpc-gateway HTTP on one port; artifact up/download endpoints and the embedded UI (`ui/embed.go`) are mounted directly. Auth (`server/auth`) is chosen per-request from the Authorization header: `client` (caller's k8s token, their RBAC), `server` (server's service account), `sso` (OIDC claims mapped to service accounts via RBAC labels); gatekeeper interceptors stash per-request clients in ctx (`auth.GetWfClient(ctx)`). Workflow archive lives in `server/workflowarchive` over `persist/sqldb` (Postgres/MySQL).

`pkg/apiclient` gives every CLI command four transports behind one interface: argo-server gRPC, HTTP1 fallback, offline (lint without a cluster), and direct-kube (no server — service logic runs in-process against the k8s API).

### Shared layers

`workflow/common` (label/annotation keys, container names, `/var/run/argo` paths), `workflow/validate` (lint/submit/controller all share it), `workflow/templateresolution` (resolves `templateRef` chains, caches in `Status.StoredTemplates`), `workflow/artifacts` (driver per storage backend: s3, gcs, azure, oss, hdfs, git, http, raw, plugin), `workflow/sync` (semaphores/mutexes, configmap- or database-backed), `workflow/util` (submit/retry/resubmit operations shared by CLI and server), `workflow/cron`.
