# workflows

This React app is embedded in the `argo server` binary. It keeps the upstream Argo Workflows API and resource names.

Run `corepack yarn --cwd ui start` for local development with an existing server, or use `hack/mock-argo-server.py` as a mock backend. See the [repository README](../README.md) and [local development guide](../docs/running-locally.md) for setup and tests.

## Run logs

The Logs panel shows stdout/stderr from the selected user container and hides Argo executor messages identified by the structured `time=… level=… msg=… argo=true` format.
Check **Show verbose pod logs** to see those messages; this choice is remembered in the browser.
The same display filter applies to live streams and archived log artifacts when available, but does not change the raw log API, CLI, or downloaded artifact files.
If a job emits an indistinguishable `argo=true` structured line, check the box to view it.
