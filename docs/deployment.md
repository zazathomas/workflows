# Deploy the server image

This image replaces the upstream Argo Workflows server and adds the embedded UI.
The controller, executor images, and CRDs stay on the upstream release you already run, chosen from [the compatibility matrix](compatibility.md).

Use the path that already owns your server Deployment:

- [Helm](#helm) when `helm list -n argo` shows your Argo release.
- [Manifests](#manifests) when you apply upstream's release manifest or your own Kustomize setup.

Finish one path before touching the other; both write the same Deployment.
For the first rollout, use a disposable installation.

## Helm

Keep Helm in control of the Deployment, Service, ingress, service account, and RBAC.
Use the chart version from the compatibility matrix, and leave `controller.image`, `executor.image`, and `images.tag` alone.

1. Copy [the values override](../deploy/helm-server-values.yaml), set the image to the published digest, and add the allowlists to your existing `server.extraEnv` list.
   That list is replaced, not merged, so start from `helm get values RELEASE -n argo`.

   ```yaml
   server:
     image:
       registry: ghcr.io
       repository: zazathomas/workflows
       tag: '4.1.6@sha256:DIGEST'
     extraEnv:
       - name: ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS
         value: 'catalog.example.com'
       - name: ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS
         value: 'github.com,login.microsoftonline.com'
   ```

2. Preview the change, then upgrade.

   ```bash
   helm get values RELEASE -n argo -o yaml > /tmp/argo-values.before.yaml
   helm template RELEASE argo/argo-workflows --version 2.0.14 -n argo \
     -f /tmp/argo-values.before.yaml -f deploy/helm-server-values.yaml > /tmp/argo-preview.yaml
   helm upgrade RELEASE argo/argo-workflows --version 2.0.14 -n argo \
     --reuse-values -f deploy/helm-server-values.yaml --atomic --timeout 10m
   ```

The values and rendered output can contain credentials, so keep them out of version control.

## Manifests

Install upstream's own manifest, patched with this fork's server image and settings before anything reaches the cluster.
Follow [upstream's installation guide](https://argo-workflows.readthedocs.io/en/latest/installation/) for the install variant you need: cluster, namespace, or managed namespace.
Upstream requires server-side apply for the full v4 CRDs.

[`deploy/manifests/`](../deploy/manifests/kustomization.yaml) takes that manifest straight from the upstream GitHub release asset and applies [one small patch](../deploy/manifests/argo-server-patch.yaml) to it.
No Argo YAML is stored in this repository.

1. Set the image digest and the allowlist values in `deploy/manifests/argo-server-patch.yaml`.
   The patch merges `env` entries by name and replaces `args`, which is how the auth mode changes.

2. Render and apply once.

   ```bash
   kubectl kustomize deploy/manifests > /tmp/argo-install.yaml
   kubectl create namespace argo
   kubectl apply -n argo --server-side -f /tmp/argo-install.yaml
   kubectl -n argo rollout status deployment/workflow-controller --timeout=10m
   kubectl -n argo rollout status deployment/argo-server --timeout=10m
   ```

The rendered file contains CRDs, the controller, and the patched server.
On an existing installation, review `kubectl diff -f /tmp/argo-install.yaml` before applying.
If you previously changed this Deployment with `kubectl set image`, `kubectl set env`, or `kubectl patch`, that first apply may report field conflicts; add `--force-conflicts` once.

Rendering fetches the release asset, so it needs network access.
The URL in `kustomization.yaml` is pinned to an upstream release tag; `python3 hack/upstream-install.py --list` prints every registered release with its install URL and checksum.
For an offline or air-gapped build, download that file and point `resources` at the local copy instead.

To move to another release, change the tag in the URL and render again. The patch is reapplied every time, so the image and settings do not drift.
For GitOps, commit this patch and your own manifest source rather than editing the cluster by hand.

## Allowlists

Both variables belong on the `argo-server` Deployment, never in the controller ConfigMap or workflow Pods.

| Variable | What it enables | Default |
| --- | --- | --- |
| `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` | Server-side HTTPS [dynamic parameter sources](parameter-sources.md) | Empty, so URL sources stay disabled |
| `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` | Browser links from [Run actions](run-actions.md) | Empty, so no links are offered |

Use exact DNS hostnames without schemes, ports, or wildcards.
Approving a host for one list does not approve it for the other.
ConfigMap-backed parameter sources need no host entry, but they still need the caller's ConfigMap RBAC.
Run-action hosts do not grant the server network egress, and users still need permission to read workflow and pod logs.
For the [synthetic Run-action demo](run-actions.md#try-the-demo-job), set the second value to `example.com` on a disposable installation.

## Verify and roll back

Check the same things for either path:

- the server Pods are ready and not restarting;
- `/api/v1/info` answers and the embedded UI loads;
- your sign-in method works with the expected Kubernetes permissions;
- a submission reaches `Succeeded` and its logs appear;
- if enabled, a Run action prompt appears and a parameter selector returns options.

The readiness probe only proves the server process answers, not that the controller, database, or artifact store is healthy.

- Helm: `helm rollback RELEASE PREVIOUS_REVISION -n argo --wait`, then revert the values file so the next reconcile does not reapply the fork image.
- Manifests: point the patch at the previous digest, re-render, and apply again.

Either way, keep the controller, executor, and CRDs on a release listed in the compatibility matrix.

## Security notes

The patch sets `--auth-mode=client`, which the parameter-source extension needs; keep your own auth, TLS, and namespace arguments if they differ.
Do not put port 2746 on the internet without an ingress or gateway that enforces TLS, access controls, and request limits.
Do not expose server auth mode to untrusted users, because it uses the server's service account.
Review the server ClusterRole before applying it, especially access to Secrets and namespaces.
