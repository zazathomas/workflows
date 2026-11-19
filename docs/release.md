# Release workflows

The release workflow publishes from `https://github.com/zazathomas/workflows` and refuses to run under any other repository name.
Tooling fetches upstream tags and release assets from the public Argo Workflows repository, so no extra remote is needed.

The image is tested against every release in [the compatibility matrix](compatibility.md); the API snapshot's baseline is upstream Argo Workflows **v4.1.6**.
One image covers all of them, so a release tag names the newest upstream release it targets.

Merge and verify the CI checks on the default branch first: Go tests, the per-release API contract, UI unit, lint, and browser tests, and the production image build with its runtime vulnerability scan.
Dev and build dependencies are scanned by the nightly run, which also rescans the image.
The release workflow does not repeat those suites: it calls the compatibility matrix, refuses a tag whose commit is not on the default branch, then builds each image once, scans it, and publishes, signs, and attests the result.

## Release tags

Tag with the upstream version it targets, such as `4.1.6`.
The guard rejects anything that is not `x.y.z` or `x.y.z.fix`, so a branch name or scratch tag cannot publish by accident.
The tag becomes the image tag and the reported version: `ghcr.io/zazathomas/workflows:4.1.6` reports `argo: 4.1.6`.
For a fork-only fix on an already released upstream version, publish a fourth component such as `4.1.6.1`.
The image is a multi-platform index for `linux/amd64` and `linux/arm64` (cluster conformance runs on `linux/amd64` only), and the workflow fails if either platform is missing.
State the tested upstream range in the release notes and pin the digest when deploying: the tag only records which release produced the image.

The same release also builds, scans, publishes, signs, and attests the runner image from `Dockerfile.runner` as `ghcr.io/zazathomas/workflows-runner:<tag>` ([runners](runners.md)).

## Verify a release

Verify the signed index using its `INDEX_DIGEST`.
Use `docker buildx imagetools inspect --raw IMAGE@INDEX_DIGEST` to locate the manifest digest for your target platform.
Verify that platform's CycloneDX attestation with `PLATFORM_DIGEST`; the server release scans and attests each platform digest before promoting the index.

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/zazathomas/workflows/.github/workflows/release.yaml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/zazathomas/workflows@sha256:INDEX_DIGEST
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github.com/zazathomas/workflows/.github/workflows/release.yaml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/zazathomas/workflows@sha256:PLATFORM_DIGEST
```

## Practicalities

Protect release tags and require approval for the `production` GitHub Actions environment before creating one.
Enable GitHub Actions to write the GHCR package, and enable private vulnerability reporting.
Restrict access to the repository and the package, and review scan results before deploying.

To move the upstream baseline: add the release to `hack/upstream-versions.json`, run `make upstream-contract`, let the compatibility matrix pass for it ([the commands](compatibility.md#add-a-release)), then regenerate the API snapshot from that release in a compatible upstream checkout and update the baseline.
Review auth, archive, artifact, and workflow semantics against the release, and do not claim a new baseline before the cluster-backed matrix passes with it.
Rollback restores the previous signed digest, keeping the controller, executor, and CRDs on a release the restored image lists.
