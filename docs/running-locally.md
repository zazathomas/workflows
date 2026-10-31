# Running locally

workflows builds Argo Server with an embedded UI.
Live workflow execution requires an existing Argo Workflows installation with a controller and CRDs.
The fork does not build the controller or executor.

## Build the server

Install Go, Node.js and Yarn, then run:

```bash
make cli
./dist/argo server --help
```

The binary embeds the production UI.
The upstream code generation pipeline is not included in this minimal fork.

## Develop the UI

Forward an existing Argo Server service to localhost, substituting its namespace and service name:

```bash
kubectl -n <namespace> port-forward service/<argo-server-service> 2746:2746
```

In another terminal, start the UI:

```bash
yarn --cwd ui install
yarn --cwd ui start
```

Open <http://localhost:8080>.
The development server proxies API and artifact requests to port 2746.
The existing server's authentication configuration still applies.
Do not share authorization cookies or tokens.

For a UI-only mock backend, see the [repository README](../README.md).

## Run tests

```bash
make test-hack
make compatibility
KUBECONFIG=/dev/null GOFLAGS='-mod=mod -tags=kubernetes_protomessage_one_more_release' go test ./server/...
yarn --cwd ui test --runInBand
yarn --cwd ui playwright install chromium
yarn --cwd ui playwright test -c playwright.mock.config.ts
```

Start the UI development server before the mock-backed Playwright suite.
The suite intercepts API requests; it does not create cluster resources.
See `ui/e2e/README.md` in the repository for browser configuration and live-test precautions.

The conformance scripts (`hack/conformance.sh`, `hack/conformance-run-action.sh`, and `hack/conformance-parameter.sh`) require an explicitly prepared, disposable installation of a release listed in [the compatibility matrix](compatibility.md).
Never run them against a shared cluster.
To create that installation yourself, run `bash hack/conformance-version.sh v4.1.3 workflows:local` with a locally built image; it manages its own kind cluster.
To check the API contract for every listed release, run `make upstream-versions` once and then `make upstream-contract`.
The retained Go API E2E suite (`make test-api`) also requires an explicitly prepared, disposable upstream Argo installation.
It creates and deletes resources in the `argo` namespace and requires the fixtures and persistence configuration expected by the suite.
Do not run it against a shared or production cluster.

## Deploy the server

Build the production image with `docker build --target server -t workflows:local .`.
Use [deployment](deployment.md) to install a signed release digest alongside an upstream controller and CRDs from the same listed release.
Review authentication, TLS and RBAC before deploying.
