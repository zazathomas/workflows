# Development helpers

- `mock-argo-server.py` runs the UI against a local mock API without a cluster.
- `upstream-versions.json` lists the upstream releases this image is tested against, with the commit, install-manifest checksum, and Helm chart version for each.
- `verify-upstream-contract.py` compares the retained API contract with every registered release (`--all`) or one release (`--tag`), and fails when a release would need a path, field, type, enum value, or protobuf tag the fork does not have.
- `fetch-upstream-versions.py` fetches the registered release tags so the contract check can read them.
- `upstream-install.py` prints the pinned `install.yaml` URL and checksum for a registered release, and can download and verify it (`--download`) for offline builds.
- `deploy/manifests/` renders the upstream release asset from GitHub with the fork's server patch; no Argo YAML is stored in the repository.
- `tests/` holds unit tests for the contract tooling; run `make test-hack`.
- `conformance.sh`, `conformance-run-action.sh`, and `conformance-parameter.sh` test a server image against a disposable upstream cluster; see [the compatibility guide](../docs/compatibility.md).
- `conformance-version.sh <tag> [image]` creates a disposable kind cluster, installs one registered release, swaps in the server image, and runs all three conformance scripts; see [the compatibility guide](../docs/compatibility.md).
- `nsswitch.conf` and `ssh_known_hosts` are copied into the server image by the [Dockerfile](../Dockerfile); `update-ssh-known-hosts.sh` regenerates the latter and checks the pinned host-key fingerprints.

API, CRD, protobuf, and client generation require an upstream checkout and are not supported by this fork.
