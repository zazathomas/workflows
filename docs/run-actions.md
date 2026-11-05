# Run actions

workflows can show a link from a running Job when a person needs to finish a step in a browser, such as device-code sign-in.
Only Jobs whose template carries an action marker are monitored.
The normal Argo workflow status remains the source of truth; clicking the link does not approve the request or resume a suspended workflow.

## Examples

Runnable WorkflowTemplates live in [`examples/`](../examples/README.md):

- [`run-actions-link-only.yaml`](../examples/run-actions-link-only.yaml) - a link with no code.
- [`run-actions-renewed.yaml`](../examples/run-actions-renewed.yaml) - a second request with a new id, as a refreshed code arrives.
- [`run-actions-expiry.yaml`](../examples/run-actions-expiry.yaml) - an ignored expired request and one that lapses after three minutes.
- [`run-actions-sidecar.yaml`](../examples/run-actions-sidecar.yaml) - the marker comes from a sidecar container.
- [`run-actions-unapproved-host.yaml`](../examples/run-actions-unapproved-host.yaml) - a well-formed request for a host outside the allowlist.
- [`device-login-run-action.yaml`](../examples/device-login-run-action.yaml) - GitHub device flow, simulated or real.
- [`run-action-demo.yaml`](../examples/run-action-demo.yaml) - two fake requests for UI testing.

## Configure a Job

Add an annotation to a WorkflowTemplate or ClusterWorkflowTemplate:

```yaml
metadata:
  annotations:
    workflows-ui-action-marker: 'NEEDS_USER_ACTION:'
    # Optional: the Kubernetes container name whose logs carry the event (default: main).
    workflows-ui-action-container: main
```

The marker must be 1–80 characters from `A–Z`, `a–z`, `0–9`, `_`, `.`, `:`, and `-`.
It must appear at the start of a single pod log line, immediately followed by a JSON object.
The emitting container prints one complete line per request:

```text
NEEDS_USER_ACTION:{"kind":"open-url","id":"device-login-1","title":"Sign in to continue","url":"https://github.com/login/device","code":"ABCD-1234","expiresAt":"2030-01-01T00:00:00Z"}
```

`kind` must be `open-url`.
`id` must be unique within a Run; a renewed code needs a new ID.
`url` must use HTTPS and an administrator-approved hostname.
`title` is short text shown to the user.
`code` and `expiresAt` are optional; omit `code` when the URL already includes the one-time code.
Do not log access tokens, refresh tokens, or a device-code grant secret in the event.

Configure the server with `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=github.com,login.microsoftonline.com` using [the deployment guide](deployment.md#allowlists).
The value is a list of exact DNS hostnames without schemes, ports, or wildcards.
It defaults to empty, which disables clickable run actions.
This is a browser navigation policy, separate from `ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS` and from server egress controls.
Job authors cannot extend the server's approved host list.

A template editor can put a device code from their own OAuth client in a marked log line and make it look like a sign-in request from the Job.
The host allowlist checks the link destination, not who issued the code.
Restrict who can edit WorkflowTemplates and ClusterWorkflowTemplates with `workflows-ui-action-marker`, and approve those templates before users submit them.
When a prompt appears, check the Run namespace, Job and destination host, and authorize only a device request you started.

## Try the demo Job

On a disposable installation of a [supported upstream release](compatibility.md), use [the demo template](../examples/run-action-demo.yaml) to exercise the UI without real credentials.
The example targets the `argo` namespace; if you use another namespace, change the RoleBinding subject namespace in the YAML before applying it.
Its service account has only `create` and `patch` access to `WorkflowTaskResult` resources, which the executor needs to complete the Run.
The submitting user still needs permission to submit Workflows from templates and read pod logs in that namespace.

On that disposable installation, enable the example host and apply the template:

```bash
kubectl -n argo set env deployment/argo-server ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=example.com
kubectl -n argo rollout status deployment/argo-server
kubectl -n argo apply -f examples/run-action-demo.yaml
```

In workflows, open **Jobs**, choose `run-action-demo`, and select **Run job**.
The first prompt offers `https://example.com/` with the fake code `DEMO-ONE`; after 60 seconds, another prompt appears with ID `demo-2` and code `DEMO-TWO`.
The container stays running for 90 more seconds so you can test navigation, reload, and the persistent action indicator.
The example never waits for authorization: clicking the link does not complete a device login or control the Run.

After the test, delete any submitted demo Runs and the example resources, then restore the server's previous allowlist:

```bash
kubectl -n argo delete workflows -l workflows.argoproj.io/workflow-template=run-action-demo
kubectl -n argo delete -f examples/run-action-demo.yaml
```

## What the user sees

After submission, the UI stays on the new Run's Overview tab.
When a marked line appears, a dialog shows the request, a link that opens in another tab, and an optional copyable code.
The original tab continues to follow the Run even if the user navigates elsewhere in workflows.
A Run action indicator lets the user reopen a dismissed request.
Requests are handled one at a time and removed when the Run finishes or the code expires.
The UI follows at most two opted-in Runs at once; additional Runs wait for a monitoring slot, and the UI shows that delay.
The UI monitors while it is open; it cannot notify a user after the browser is closed.
Refreshing the same tab restores tracked active Runs and scans available logs again, provided the pod logs and the effective Kubernetes log permissions are still available.

When a Run has one pod, the UI requests only that pod's logs; otherwise the server's log endpoint lists and watches the Run's pods using the effective credentials for the current auth mode.
In client auth mode, grant the submitter the appropriate workflow and pod-log permissions.
Do not expose server auth mode to untrusted users, since it uses the server's service account.
Pods removed by pod GC can make an old request unavailable; configure a suitable pod retention window for these Jobs.
