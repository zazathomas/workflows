# workflows compatibility

One `workflows` image runs against several upstream Argo Workflows releases.
The tested set lives in [`hack/upstream-versions.json`](../hack/upstream-versions.json) and currently covers the v4.1 line:

| Upstream release | Helm chart |
| --- | --- |
| v4.1.0 | 2.0.0 |
| v4.1.1 | 2.0.1 |
| v4.1.2 | 2.0.5 |
| v4.1.3 | 2.0.6 |
| v4.1.4 | 2.0.11 |
| v4.1.5 | 2.0.13 |
| v4.1.6 | 2.0.14 |

The baseline is v4.1.6, the release the checked-in API snapshot comes from.
Every listed release has the same OpenAPI and protobuf wire contract as the baseline, so the server exposes the fields those clusters and clients expect.
`make upstream-contract` proves that on every run and fails if a release needs a path, field, type, enum value, or protobuf tag the fork does not have.
Releases that differ in those ways, such as v4.0.15, fail the check and are not supported.

## What a supported release means

The image is published only after both of these pass for every listed release:

- the contract check for that release;
- a disposable kind cluster running that release's controller, executor, and CRDs, with the fork image replacing the server, exercising the API and UI, submission and execution, the watch endpoint, logs, a suspended CronWorkflow, Run actions from real pod logs, the parameter-source authorization boundary, and anonymous access denial.

[`compatibility.yaml`](../.github/workflows/compatibility.yaml) runs that matrix on a schedule, on demand, and before a release publishes.
Pull requests only run the contract check, so a schema break is caught before merge and the slower cluster runs stay off the critical path.

To run one release locally, build the server image and run `bash hack/conformance-version.sh v4.1.3 workflows:local`.
The script creates a kind cluster, installs that release's controller, executor, and CRDs from the registered checksum, loads your local image, and deletes the cluster when it finishes.
It never targets a cluster you did not create, so do not point `KUBECONFIG` at anything shared.
Set `KEEP=1` to keep the cluster after a failure.

Conformance scripts bind a free local port by default, because a local `argo server` on 2746 would otherwise answer instead of the test installation.
Set `ARGO_CONFORMANCE_PORT` to force a specific port.

Every listed release has been run through that suite against the current image.
The matrix does not exercise every API operation or optional feature.
It does not provision a persistence database, workflow archive, external artifact store, or SSO provider.
Before enabling those in production, run integration tests against a disposable installation with the same configuration, on the release you intend to run.

## One image, several releases

The image contains the server and UI only.
The controller, executor images, and CRDs come from whichever listed release you install, and they must match each other.
Do not pair a v4.1.6 controller with v4.1.0 CRDs.
Image tags use the upstream version they target (`4.1.6`); see [the release guide](release.md#release-tags).

Pick the release your cluster already runs, then point the deployment source at it:

- Helm: use the chart version from the table in [the deployment guide](deployment.md#helm).
- Manifests: put that release's tag in the `install.yaml` URL in `deploy/manifests/kustomization.yaml`, then render and apply it with the server patch as described in [the deployment guide](deployment.md#manifests).

## Add a release

You do not need a new image tag for a new upstream release: the same image serves every listed release once its entry passes.
Adding a release is a registry change plus proof that it works.

1. Fetch the tag and note its commit and Helm chart version.

   ```bash
   git fetch --depth=1 origin tag v4.1.7
   git rev-parse 'v4.1.7^{commit}'
   helm search repo argo/argo-workflows --versions | awk '$3=="v4.1.7" {print $2; exit}'
   ```

2. Download the release manifest to compute its checksum. This works before the release is registered.

   ```bash
   python3 hack/upstream-install.py v4.1.7 --download /tmp/install.yaml
   ```

   The command prints the `installManifestSha256` value to copy into the registry.

3. Add the tag, commit, checksum, and chart version to [`hack/upstream-versions.json`](../hack/upstream-versions.json), then check the contract.

   ```bash
   make upstream-contract
   ```

   An additive-only result means the current image can serve the release.
   A breaking result means the fork lacks something the release exposes, so either leave the release out or rebuild the generated API files from it in a compatible upstream checkout and make it the new baseline.

4. Test the image against a disposable cluster with the real controller and CRDs.

   ```bash
   docker build --target server -t workflows:local .
   bash hack/conformance-version.sh v4.1.7 workflows:local
   ```

5. Run the compatibility workflow (Actions, then **workflows compatibility matrix**, **Run workflow** with scope `full`).
   It reads the matrix from the registry, so the new release is picked up automatically.

6. Update the table above, then merge.

Moving the baseline to a new release is a separate change: it means regenerating the API snapshot from that release in a compatible upstream checkout.
See [the release guide](release.md) for that step and for what to review in auth, archive, artifacts, and workflow semantics.

## Remove a release

Delete its entry from `hack/upstream-versions.json`, rerun `make upstream-contract`, and update the table.
Removing the baseline also means regenerating the API snapshot from the new baseline in a compatible upstream checkout; the table and the release tooling both assume the baseline is present.

## Baseline versus tested releases

The checked-in Go API types, protobufs, and OpenAPI schema are a snapshot of the baseline release.
`hack/verify-upstream-contract.py` requires an exact match with the baseline and allows only additive differences for other listed releases.
That is why the same image serves all of them without per-release builds.

## Limits

The Kubernetes platform must satisfy each release's own requirements.
The matrix runs on Kubernetes v1.34; other versions have not been verified by this fork.
Support is per minor line: adding a release from a different minor version, such as v4.0.x or a future v4.2, needs its own review of the contract diff, defaulted fields, and controller behavior.
