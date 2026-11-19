# Run a workflow on Kubernetes and remote Linux

Use native Argo templates for Kubernetes steps and the `runner` executor plugin for remote steps.
The stock controller and agent run both kinds of step without `disableAgentPodCreation`.
The plugin submits the resolved step and polls for its result over HTTPS.
The standalone broker keeps queue and attempt state in PostgreSQL; the remote `argo-runner` still enrolls and polls over its existing signed protocol.
Neither the broker nor remote workers need Kubernetes credentials.

## Install for one trust domain

The [example manifests](../deploy/runner-broker/) use Argo Workflows v4.1.6, namespace `builds`, and pool `build`.
Each broker deployment serves one namespace and pool; use separate credentials and broker deployments for distinct trust domains.

1. Build and publish the image using `docker buildx build --platform linux/arm64,linux/amd64 -f Dockerfile.runner-broker -t "$BROKER_IMAGE" --push .` after setting `BROKER_IMAGE` to your registry and tag.
   Verify the pushed image and replace the references in both manifests with its registry digest.
2. Create `runner-system` and `builds`, and provision a dedicated PostgreSQL database with TLS verification for the broker's database connection.
   Run `argo-runner-broker migrate` with `BROKER_DATABASE_URL` before starting the broker.
3. In `runner-system`, create Secrets `runner-broker-database` (key `url`), `runner-broker-tls` (`tls.crt` and `tls.key`), and `runner-broker-plugin` (`token`).
   Copy only the plugin token to a separate Secret named `runner-broker-plugin` in `builds`.
   Use a random token with at least 32 bytes of entropy and certificates trusted by both the plugin and workers.
   The certificate must cover the Service hostname and any separately configured worker-facing hostname.
   If you issue it from a private CA, inject its PEM into the plugin through `BROKER_CA_PEM` and configure the workers to trust that CA.
4. Apply `broker.yaml`, `plugin.yaml`, and `workflow-rbac.yaml`.
   Give the controller its upstream task-set permissions, including `patch` on `workflowtasksets/status` for reconciliation.
   The example creates the token Secret the stock v4.1 agent mounts for `runner-workflow`.
   Keep that Secret scoped to the workflow service account and out of reach of job authors.
   Enable `ARGO_EXECUTOR_PLUGINS=true` on the controller, leave workflow-level plugins disabled, and set `disableAgentPodCreation: false` in its configuration.
   Remove the old `ARGO_SERVER_RUNNERS_*` environment variables and runner-specific RBAC from any previous installation.
5. Expose the broker to the worker network with TLS and ingress request limits.
   Expose the runner protocol to workers; restrict `/v1/plugin/submit` to the trusted agent network at the ingress or use a private Service route for it.
   Do not log request queries, bodies, or authorization headers.
6. Run `argo-runner-broker mint 15m` in the operator environment with the broker configuration to get a single-use pool token.
   Enroll each runner against the broker HTTPS origin and use a fresh credentials directory when migrating from the embedded dispatcher.
   Remove the join token after enrollment and run the existing `argo-runner run` with a restrictive local policy.
   Use `argo-runner-broker revoke RUNNER_ID` to revoke a worker.
7. Submit [the mixed workflow](../examples/mixed-runner-broker.yaml).
   It starts in a Kubernetes pod, executes a remote step, then checks the returned artifact in another Kubernetes pod.

Keep the plugin credential, plugin ConfigMap, agent pod, and task-set status out of reach of workflow authors.
In particular, a Kubernetes pod creator can normally ask the kubelet to inject a namespace Secret even without Kubernetes `get` on that Secret.
Use operator-owned templates and admission controls to prevent arbitrary Secret references, service account selection, agent access, and pod patches in the plugin namespace.
Apply NetworkPolicy with a CNI that enforces it, and use disposable or sandboxed workers for jobs that cross a trust boundary.

## Retries, limits, and migration

Specify `node: "{{node.name}}"` on each remote step.
If the template uses Argo `retryStrategy`, also include `retry: "{{retries}}"` in the `runner` body so each Argo retry has a distinct broker identity.
Repeated plugin calls with the same workflow UID, node name, retry index, and input body return the same job.
If a worker misses its lease, the broker can give the job another attempt; it rejects results and uploads from the previous claim.
Jobs with external side effects still need idempotency because execution is at least once.
The broker asks the worker to stop on heartbeat if Argo has not polled the step for two minutes or the deadline expires.
The deadline includes time spent queued and defaults to 30 minutes.

The broker supports parameters, inline raw inputs and UTF-8 output artifacts, with a combined maximum of four artifacts and caps of 256 KiB on aggregate input data and on each output.
Logs are persisted in PostgreSQL with a per-attempt cap of 1 MiB; the UI does not read them.
This first implementation does not provide object-store transfers, Kubernetes Secret resolution, worker attestation, legacy runner admin/UI integration, or automatic retention of completed jobs.
Monitor database growth and archive it according to your retention policy; deleting a job record while Argo may still poll it removes its idempotency record.
Drain any old runs before updating argo-server; the embedded dispatcher and its API have been removed.
For rollback, drain the broker before returning to the previous server image and controller configuration.
Pending broker jobs do not transfer back to the previous dispatcher.
