# Browser tests

The fork's mock-backed browser suite checks the submit wizard, navigation, filters, keyboard use, and live-status UI without a cluster.
Run `make test-ui-e2e`: Playwright starts the UI dev server itself (and reuses one you already have running).
Set `ARGO_UI_BASE_URL` to run the suite against a server you started elsewhere, such as the container flow in `ui/AGENTS.md`.
CI runs this suite for each pull request.
The mock does not prove that a production image works with the upstream controller.

The compatibility workflow separately builds the production image and runs `hack/conformance-version.sh` against every supported upstream release, as described in the [compatibility guide](../../docs/compatibility.md).
The retained upstream live Playwright suite (`yarn --cwd ui e2e`) creates and deletes real workflows and needs a separately configured disposable cluster; it is not part of ordinary CI.
Do not run it against a shared or production cluster.
