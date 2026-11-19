# workflows compatibility

One `workflows` image runs against several upstream Argo Workflows releases.
The tested set lives in [`hack/upstream-versions.json`](../hack/upstream-versions.json) and covers the v4.1 line:

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
Every listed release has the same OpenAPI and protobuf wire contract as the baseline; `make upstream-contract` proves it and fails if a release needs a path, field, type, enum value, or protobuf tag the fork does not have.
Releases that differ in those ways, such as v4.0.15, are not supported.

## What support means

The image is published only after both checks pass for every listed release:

- the contract check for that release;
- a disposable kind cluster running that release's controller, executor, and CRDs with the fork image as the server, exercising the API and UI, submission and execution, the watch endpoint, logs, a suspended CronWorkflow, Run actions from real pod logs, the parameter-source authorization boundary, and anonymous access denial.

A second disposable cluster per release runs stock Argo pods, the standalone PostgreSQL broker, and a Docker runner outside Kubernetes through `hack/conformance-runner-version.sh`.

[`.github/workflows/compatibility.yaml`](../.github/workflows/compatibility.yaml) runs the matrix on a schedule, on demand, and before a release; its `scope: contract` dispatch skips the cluster jobs.
Pull requests only run the contract check, so a schema break is caught before merge.

The matrix does not exercise every API operation or optional feature: it provisions no persistence database, workflow archive, external artifact store, or SSO provider.
Test those against a disposable installation with your own configuration before enabling them in production.

## Run one release locally

```bash
docker build --target server -t workflows:local .
bash hack/conformance-version.sh v4.1.3 workflows:local
```

The script creates a kind cluster, installs that release's controller, executor, and CRDs from the registered checksum, loads your image, and deletes the cluster afterwards (or keeps it with `KEEP=1`).
It binds a free local port by default so a local `argo server` on 2746 cannot answer instead of the test installation; set `ARGO_CONFORMANCE_PORT` to force one.
Never point `KUBECONFIG` at a shared cluster.

## One image, several releases

The controller, executor images, and CRDs come from whichever listed release you install, and they must match each other: do not pair a v4.1.6 controller with v4.1.0 CRDs.
Image tags name the newest upstream release the image was tested against (`4.1.6`); see [the release guide](release.md#release-tags).

Pick the release your cluster already runs, then:

- Helm: use the chart version from the table above ([deployment guide](deployment.md#helm)).
- Manifests: put that release's tag in the `install.yaml` URL in `deploy/manifests/kustomization.yaml` and render it ([deployment guide](deployment.md#manifests)).

## Add a release

No new image tag is needed: the same image serves a listed release once its entry passes.

1. Fetch the tag and note its commit and Helm chart version:

   ```bash
   git fetch --no-tags --depth=1 \
     https://github.com/argoproj/argo-workflows.git refs/tags/v4.1.7:refs/tags/v4.1.7
   git rev-parse 'v4.1.7^{commit}'
   helm search repo argo/argo-workflows --versions | awk '$3=="v4.1.7" {print $2; exit}'
   ```

2. Compute the manifest checksum (this works before the release is registered):

   ```bash
   python3 hack/upstream-install.py v4.1.7 --download /tmp/install.yaml
   ```

3. Add the tag, commit, checksum, and chart version to [`hack/upstream-versions.json`](../hack/upstream-versions.json), then run `make upstream-contract`.
   An additive-only result means the current image can serve the release; a breaking result means the fork lacks something the release exposes, so leave the release out or rebuild the generated API files from it in a compatible upstream checkout and make it the new baseline.

4. Test against a disposable cluster:

   ```bash
   docker build --target server -t workflows:local .
   bash hack/conformance-version.sh v4.1.7 workflows:local
   ```

5. Run the compatibility workflow (Actions → **workflows compatibility matrix** → **Run workflow**, scope `full`), then update the table above and merge.

## Remove a release

Delete its entry from `hack/upstream-versions.json`, rerun `make upstream-contract`, and update the table.
Removing the baseline also means regenerating the API snapshot from the new baseline.

## Limits

The checked-in Go API types, protobufs, and OpenAPI schema are a snapshot of the baseline release: `hack/verify-upstream-contract.py` requires an exact match with the baseline and allows only additive differences elsewhere.
That is why one image serves them all.
The Kubernetes platform must satisfy each release's own requirements; the matrix runs on Kubernetes v1.34, and other versions are unverified.
Support is per minor line: a release from another minor version, such as v4.0.x or a future v4.2, needs its own review of the contract diff, defaulted fields, and controller behaviour.
