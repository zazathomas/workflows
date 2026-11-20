# Running locally

workflows builds Argo Server with an embedded UI.
Live workflow execution needs an existing Argo Workflows installation with a controller and CRDs; this fork does not build either.
Run every build, test, and dev server in a container, using the images pinned in `Dockerfile` (see the repository `AGENTS.md`), and keep caches in named volumes.

## Build the server

The Go build embeds `ui/dist/app`, so build the UI bundle first:

```bash
# UI bundle (node pin from Dockerfile's argo-ui stage)
docker run --rm -v "$PWD":/src -v workflows-ui-nm:/src/ui/node_modules -w /src node:24-alpine3.23 \
  sh -c 'apk add git && yarn --cwd ui install --frozen-lockfile && yarn --cwd ui build'

# server binary at dist/argo (Go pin from Dockerfile's builder stage)
docker run --rm -v "$PWD":/src -v workflows-go-mod:/go/pkg/mod -w /src golang:1.27.3-alpine3.23 \
  sh -c 'apk add git make ca-certificates bash && make dist/argo'
```

`./dist/argo server` then serves the API and UI on port 2746.
`make cli` is the same thing for a host with Go, Node, and Yarn already installed.
The upstream code generation pipeline is not part of this fork.

## Develop the UI

Forward an existing argo-server to localhost, substituting its namespace and service name:

```bash
kubectl -n <namespace> port-forward service/<argo-server-service> 2746:2746
```

Then start the dev server (`:8080`, proxying API and artifact requests to `:2746`):

```bash
docker run --rm -v "$PWD":/src -v workflows-ui-nm:/src/ui/node_modules -w /src/ui -p 8080:8080 node:24-alpine3.23 \
  sh -c 'apk add git && yarn start --host 0.0.0.0'
```

The existing installation's authentication still applies; do not share authorization cookies or tokens.
For a UI-only mock backend, use [`hack/mock-argo-server.py`](../hack/README.md) as described in the [repository README](../README.md).

## Run tests

| Target | What it runs | Needs |
| --- | --- | --- |
| `make test-ui` | UI unit tests (Jest) | node image |
| `make test-ui-e2e` | Mock-backed browser tests | Playwright image (see `ui/AGENTS.md`) |
| `make lint` | UI ESLint `--fix` and TypeScript checks | node image |
| `make test-hack` | Compatibility tooling unit tests | python3 |
| `node --test hack/tests/ci-workflows.test.js` | CI coverage and artifact wiring checks | node image, installed UI dependencies |
| `make upstream-versions` | Fetches every registered upstream tag (once) | python3, git |
| `make upstream-contract` | API contract for every registered release | python3, fetched tags |
| `make compatibility` | Contract check plus server, CLI, and runner Go tests | python3, Go, UI bundle |
| `make test-api` | Live upstream API e2e suite | Go, disposable installation |

`make test-ui-e2e` reuses a dev server already running on `:8080` and otherwise starts one; set `ARGO_UI_BASE_URL` to point it elsewhere, for example the container flow in `ui/AGENTS.md`.
The suite intercepts API requests and creates no cluster resources; see [`ui/e2e/README.md`](../ui/e2e/README.md).
CI runs Jest, lint, and browser tests in `mcr.microsoft.com/playwright:v1.64.0` with Node 24, using the image's preinstalled browsers and system dependencies.
When you update `@playwright/test` in `ui/yarn.lock`, update the CI container version too; CI checks that the versions match.

Run the workflow wiring checks with the existing Node container and dependency volume:

```bash
docker run --rm -v "$PWD":/src -v workflows-ui-nm:/src/ui/node_modules -w /src node:24-alpine \
  node --test hack/tests/ci-workflows.test.js
```

The conformance and API suite scripts (`hack/conformance*.sh`, `make test-api`) create and delete real resources and need an explicitly prepared, disposable installation of a [supported release](compatibility.md).
They never target a cluster you did not create, and must not run against a shared or production cluster.
To make one yourself, run `bash hack/conformance-version.sh v4.1.3 workflows:local` after building the image; it manages its own kind cluster.

## Deploy the server

Build the production image with `docker build --target server -t workflows:local .`, then follow [deployment](deployment.md) to install a signed release digest alongside an upstream controller and CRDs from the same release.
Review authentication, TLS, and RBAC before deploying.
