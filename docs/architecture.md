# workflows architecture

This repository builds `argo server` and embeds the React UI in its binary.
The image does not contain a workflow controller or `argoexec`.
Install an upstream Argo Workflows controller, executor images, and CRDs from a [supported release](compatibility.md) separately.
The server talks to Kubernetes using its service account for caches and, in client auth mode, the caller's credentials for API operations.

`server/apiserver` hosts the upstream gRPC and HTTP APIs, artifact routes, and embedded UI on port 2746.
`server/parameter` implements the fork's parameter-options extension.
It reads the selected parameter source from a WorkflowTemplate or ClusterWorkflowTemplate that the caller can access, then fetches an allowlisted HTTPS endpoint or ConfigMap.
The extension is disabled in server auth mode and in SSO without RBAC.

`ui/src/workflows/components/workflow-logs-viewer` filters executor log lines out of the Logs panel by default; it changes only what the browser displays, not the log API.
`hack/upstream-versions.json` lists the upstream releases this image is tested against, and the compatibility workflow runs that matrix.

`server/runaction` exposes the administrator's approved link hosts to authenticated UI clients.
`ui/src/run-actions` watches existing workflow and pod-log streams for opted-in Runs while the browser is open.
Run actions add no Argo CRD or generated API field.

The UI changes Argo names only on screen: a Job is a WorkflowTemplate or ClusterWorkflowTemplate, and a Run is a Workflow.
The underlying API and Kubernetes resources retain their upstream names.
For workflow execution and controller internals, use the [upstream documentation](https://argo-workflows.readthedocs.io/en/latest/).
