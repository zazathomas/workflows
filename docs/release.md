# Release workflows

The release workflow publishes from `https://github.com/zazathomas/workflows` and refuses to run under any other repository name.
The tooling fetches upstream tags and release assets from the public Argo Workflows repository, so no extra remote is required.

The image is tested against every release in [the compatibility matrix](compatibility.md), and the API snapshot's baseline is upstream Argo Workflows **v4.1.6**. One image covers all of them, so a release tag names the newest upstream release it targets rather than a separate build per release.
First merge and verify the CI checks: Go compatibility, UI unit/type/browser tests, production-image build, and vulnerability scan.
The nightly CI run scans the image again for newly disclosed vulnerabilities.
A release Git tag, such as `4.1.6`, starts `.github/workflows/release.yaml`.
Protect those tags and require approvals for the `production` GitHub Actions environment before creating one.
Enable GitHub Actions to write the GHCR package and enable private vulnerability reporting.

## Release tags

Tag a release with the upstream version it targets, such as `4.1.6`.
The workflow rejects anything that is not `x.y.z` or `x.y.z.fix`, so a branch name or scratch tag cannot publish by accident.
The tag becomes the image tag and the reported version: `ghcr.io/zazathomas/workflows:4.1.6` reports `argo: 4.1.6`.
The image is published as a multi-platform index for `linux/amd64` and `linux/arm64`, and the workflow fails if either platform is missing; cluster conformance runs on `linux/amd64` only.
One image serves every release in the compatibility matrix, so the tag names the newest upstream release it was tested against, not the only one it supports.
For a fork-only fix on an already released upstream version, publish a fourth component such as `4.1.6.1`.
State the tested upstream range in the release notes, and pin the image digest when deploying; the tag only records which release produced the image.

The compatibility workflow builds the server image once, then installs each listed upstream controller and its CRDs in a disposable kind cluster and runs server-mode and client-mode conformance checks, including a marked Run action from real pod logs. The release job starts only after that matrix passes, then scans for high/critical vulnerabilities and generates a CycloneDX SBOM.
It publishes `ghcr.io/zazathomas/workflows:4.1.6` only after those checks pass and signs and attests the resulting immutable digest with GitHub OIDC and Cosign.
Deploy the published digest, not a mutable tag, as described in [the deployment guide](deployment.md).

After replacing `DIGEST` with the published value, verify the release:

```bash
cosign verify \
  --certificate-identity-regexp '^https://github.com/zazathomas/workflows/.github/workflows/release.yaml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/zazathomas/workflows@sha256:DIGEST
cosign verify-attestation --type cyclonedx \
  --certificate-identity-regexp '^https://github.com/zazathomas/workflows/.github/workflows/release.yaml@refs/tags/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/zazathomas/workflows@sha256:DIGEST
```

Before upgrading upstream, add the release to `hack/upstream-versions.json`, run `make upstream-contract`, and let the compatibility workflow pass for it; [the compatibility guide](compatibility.md#add-a-release) has the exact commands.
Only then regenerate the API snapshot from that release in a compatible upstream checkout and update the baseline.
Review auth, archive, artifact, and workflow semantics against that release.
Do not claim a new compatibility baseline until the cluster-backed matrix passes with it.
Rollback restores the previous signed fork image digest, keeping the controller, executor, and CRDs on a release that the restored image lists.
