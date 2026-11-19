# workflows security

Report a suspected vulnerability through this repository's private GitHub Security Advisory form under **Security → Advisories → Report a vulnerability**.
Do not report fork-only defects to the upstream Argo Workflows project.
The repository owner must enable private vulnerability reporting before publishing the image.

The image keeps the upstream server's security model for workflow creation and artifact operations, and inherits the upstream controller's model for everything it runs.
Use client auth mode with caller-scoped RBAC unless you have a documented reason for SSO with RBAC; never offer server auth mode to an untrusted audience, because it hands clients the server's service-account permissions.
For controller, executor, workflow pod, artifact store, and database hardening, follow [upstream's security guide](https://argo-workflows.readthedocs.io/en/latest/security/).

## Fork extensions

- **Parameter sources** ([guide](parameter-sources.md)): the endpoint requires the caller to be able to read the template and declares the requested source in its annotation. ConfigMap and Secret reads use the caller's identity, Secret headers cannot cross namespaces, and HTTPS fetches are limited to `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` with private and loopback targets refused. Keep the list short, add a network policy for server egress, and treat template-annotation edit rights as a grant to direct requests.
- **Environment viewer** ([guide](environment-viewer.md)): lists ConfigMaps and Secrets with the caller's RBAC and never returns values. Key names and sizes are still metadata, so grant `list` on Secrets only to people who may see them.
- **Run actions** ([guide](run-actions.md)): reads pod logs and opens links in the browser. `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` restricts clickable destinations, and the allowlist checks the destination, not who issued a device code: verify the destination before entering one. Never put access tokens in run-action events, and grant log access only to people who should see run output.
- **Approvals** ([guide](approvals.md)): grant the dedicated decide permission instead of workflow writes, and apply the opt-in admission policy and restrictive RBAC before relying on approvals as a release gate.
- **Notifications** ([guide](notifications.md)): server-side egress. Whoever can edit a namespace's `argo-notifications` ConfigMap chooses destinations, and whoever can edit a Job's annotations opts runs into them. Webhook and SMTP hosts must be in `ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS` (an empty list fails closed), and credential Secrets must carry `notifications.argoproj.io/allowed: "true"`. There is no private-network block, so listing an internal host deliberately lets the server reach it.
- **Remote runners** ([broker deployment](runner-broker.md), [threat model](runner-threat-model.md)): restrict task-set status, plugin configuration, and plugin credentials to trusted identities. The broker and remote workers hold no Kubernetes credentials. Use dedicated or disposable workers for mutually untrusted workloads.

## Supply chain

Pin releases by image digest and verify their keyless signature and SBOM attestation with Cosign ([release guide](release.md#verify-a-release)).
Protect release Git tags and the `production` environment so only approved releases receive package-write and OIDC permissions, and restrict access to the repository and the GHCR package.
