# Deploy the server image

This image replaces the upstream Argo Workflows server and adds the embedded UI.
The controller, executor images, and CRDs stay on the upstream release you already run, chosen from [the compatibility matrix](compatibility.md).
Use the path that already owns your server Deployment, and finish one path before touching the other: both write the same Deployment.
For a first rollout, use a disposable installation.

## Helm

Keep Helm in control of the Deployment, Service, ingress, service account, and RBAC, and leave `controller.image`, `executor.image`, and `images.tag` alone.

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

2. Preview, then upgrade with the chart version from the compatibility matrix:

   ```bash
   helm get values RELEASE -n argo -o yaml > /tmp/argo-values.before.yaml
   helm template RELEASE argo/argo-workflows --version 2.0.14 -n argo \
     -f /tmp/argo-values.before.yaml -f deploy/helm-server-values.yaml > /tmp/argo-preview.yaml
   helm upgrade RELEASE argo/argo-workflows --version 2.0.14 -n argo \
     --reuse-values -f deploy/helm-server-values.yaml --atomic --timeout 10m
   ```

Values and rendered output can contain credentials, so keep them out of version control.

## Manifests

[`deploy/manifests/`](../deploy/manifests/kustomization.yaml) renders the upstream release asset and applies [one patch](../deploy/manifests/argo-server-patch.yaml); no Argo YAML is stored here.
Follow [upstream's installation guide](https://argo-workflows.readthedocs.io/en/latest/installation/) for the install variant you need (cluster, namespace, or managed namespace); the full v4 CRDs need server-side apply.

1. Set the image digest and allowlist values in `deploy/manifests/argo-server-patch.yaml`.
   The patch merges `env` by name and replaces `args`, which is how the auth mode changes.

2. Render and apply:

   ```bash
   kubectl kustomize deploy/manifests > /tmp/argo-install.yaml
   kubectl create namespace argo
   kubectl apply -n argo --server-side -f /tmp/argo-install.yaml
   kubectl -n argo rollout status deployment/workflow-controller --timeout=10m
   kubectl -n argo rollout status deployment/argo-server --timeout=10m
   ```

Review `kubectl diff -f /tmp/argo-install.yaml` on an existing installation; if you previously changed the Deployment with `kubectl set image`, `set env`, or `patch`, that first apply may report field conflicts, so add `--force-conflicts` once.

Rendering fetches the release asset, so it needs network access; `python3 hack/upstream-install.py --list` prints each registered release's install URL and chart version.
For an offline build, download that file and point `resources` at the local copy.
To move to another release, change the tag in the URL and render again: the patch is reapplied every time.
For GitOps, commit the patch and your manifest source instead of editing the cluster.

## Remote runners

Deploy the [standalone runner broker and stock executor plugin](runner-broker.md) for workflows that run on remote Linux hosts.
The Argo server deployment does not need runner credentials, configuration, or extra RBAC.

## Fork worker

Deploy the [fork worker example](../deploy/fork-worker/worker.yaml) to use approvals or notifications.
Use the same fork image digest on the worker and API, and set one workload namespace per worker deployment.
Set the stock controller ConfigMap name with `--configmap` if you don't use the default; grant access to that ConfigMap only.
Replicas in the example contend for one namespace Lease, so only one reads Workflow events and runs timers.
Use a separate service account and the [egress policy example](../deploy/fork-worker/network-policy.example.yaml) on the worker.
If the stock controller offloads node status, grant the worker access to the same persistence configuration and the required database connection.

Install the record admission policy from [the protected namespace examples](../deploy/approvals/protected-namespace.yaml) and label the namespace `platform.argoproj.io/protect-extension-state=true` before enabling the extensions.
Use the separate `protect-runs` label only where you intend to restrict all workflow writes.
On the API set the approval and test-send namespace as needed; set the outbound notification allowlist only on the worker.
If you previously installed `argo-server-notify` cluster-wide, remove that ClusterRoleBinding and ClusterRole after the worker is ready.
Rolling back roles removes delivery and approval processing; keep their state ConfigMaps until you have exported or processed them.

## Allowlists

Both variables belong on the `argo-server` Deployment, never in the controller ConfigMap or workflow Pods.

| Variable | What it enables | Default |
| --- | --- | --- |
| `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` | Server-side HTTPS [dynamic parameter sources](parameter-sources.md) | Empty, so URL sources stay disabled |
| `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` | Browser links from [Run actions](run-actions.md) | Empty, so no links are offered |

Use exact DNS hostnames without schemes, ports, or wildcards.
In production, allow only catalog endpoints you control; code-hosting and CDN domains let template editors choose content that shapes submissions.
Secret-backed sources send the configured header to that host, so keep their templates in a namespace where you control who can edit them.
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
The example sets `IP_KEY_FUNC_HEADERS=X-Forwarded-For`; use it only behind an ingress that overwrites that header, or remove the setting.
Size `--api-rate-limit` for aggregate gateway traffic, and set replicas, resource requests, and a disruption budget to suit your cluster.
Do not put port 2746 on the internet without an ingress or gateway that enforces TLS, access controls, and request limits.
Do not expose server auth mode to untrusted users, because it uses the server's service account.
Review the server ClusterRole before applying it, especially access to Secrets and namespaces.
