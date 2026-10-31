# workflows security

Report a suspected vulnerability through this repository's private GitHub Security Advisory form under **Security → Advisories → Report a vulnerability**.
Do not report fork-only defects to the upstream Argo Workflows project.
The repository owner must enable private vulnerability reporting before publishing the image.

The upstream server exposes workflow creation and artifact operations and inherits the security model of the upstream controller.
Use client auth mode with caller-scoped Kubernetes RBAC unless you have a documented reason to use SSO with RBAC.
Do not use server auth mode for an untrusted audience: it makes the server's service-account permissions available to clients.
The fork's parameter-options endpoint is disabled in server auth mode and in SSO without RBAC.

The parameter endpoint checks that the caller can read the WorkflowTemplate or ClusterWorkflowTemplate and that its annotation declares the requested source.
ConfigMap and Secret reads use the authenticated request's Kubernetes identity.
Only hostnames in the server-only `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` environment variable are allowed; network dialing rejects private and loopback addresses, and response size and time are limited.
Still use a network policy to restrict server egress to the configured hosts, keep the allowlist short, and monitor outbound requests.
Users who can edit a template's annotation can direct source requests to allowlisted hosts; grant that permission deliberately.
Secret headers cannot reference another namespace.
Avoid putting sensitive parameter values in a source URL because the endpoint uses GET.

Run actions read pod logs and open external links in the user's browser.
The separate `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS` policy restricts clickable links to approved exact hostnames; keep the list short and verify the destination before entering a device code.
Only grant log access to users who should see run output, and do not put access tokens in run-action events.
See [run actions](run-actions.md) for the event format and lifecycle.

Pin releases by image digest and verify their keyless signature and SBOM attestation with Cosign.
Protect release Git tags and the `production` GitHub Actions environment; only approved releases should receive package-write and OIDC permissions.
Restrict access to the GitHub repository and GHCR package, and review vulnerability-scan results before deploying.
For controller, executor, workflow pod, artifact-store, and database hardening, follow [upstream's security guide](https://argo-workflows.readthedocs.io/en/latest/security/).
