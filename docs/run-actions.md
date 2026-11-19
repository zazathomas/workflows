# Run actions

workflows can show a link from a running Job when a person must finish a step in a browser, such as a device-code sign-in.
Only Jobs whose template carries an action marker are monitored.
The Argo workflow status stays the source of truth: clicking the link does not approve the request or resume a suspended workflow.

## Configure a Job

```yaml
metadata:
  annotations:
    workflows-ui-action-marker: 'NEEDS_USER_ACTION:'
    # Optional: the container whose logs carry the event (default: main).
    workflows-ui-action-container: main
```

The marker is 1–80 characters from `A–Z`, `a–z`, `0–9`, `_`, `.`, `:`, and `-`.
It must start a pod log line, immediately followed by one JSON object:

```text
NEEDS_USER_ACTION:{"kind":"open-url","id":"device-login-1","title":"Sign in to continue","url":"https://github.com/login/device","code":"ABCD-1234","expiresAt":"2030-01-01T00:00:00Z"}
```

- `kind` must be `open-url`; `id` must be unique within the Run (a renewed code needs a new ID).
- `url` must be HTTPS on an administrator-approved hostname.
- `title` is short text; `code` and `expiresAt` are optional (omit `code` when the URL carries it).
- Never log access tokens, refresh tokens, or a device-code grant secret.

Enable hosts on the server with `ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=github.com,login.microsoftonline.com` ([deployment](deployment.md#allowlists)).
The list is exact DNS hostnames without schemes, ports, or wildcards, empty by default, and it is a browser navigation policy separate from parameter-source egress.
Job authors cannot extend it.

A template editor can put a device code from their own OAuth client into a marked line and make it look like the Job's sign-in request: the allowlist checks the destination, not who issued the code.
Restrict who can edit templates containing `workflows-ui-action-marker`, and when a prompt appears, check the Run namespace, the Job, and the host before authorizing.

## What the user sees

After submission the UI stays on the new Run's Overview tab.
When a marked line appears, a dialog shows the request with a link that opens in another tab and an optional copyable code.
The original tab keeps following the Run, and an indicator lets the user reopen a dismissed request.
Requests are handled one at a time and dropped when the Run finishes or the code expires.
The UI follows at most two opted-in Runs at once and shows the delay for any others; it only monitors while the browser is open, so it cannot notify you afterwards.
Refreshing the tab restores the tracked Runs and rescans their logs, provided the pod logs and log permissions are still available.

With one pod the UI requests only that pod's logs; otherwise the server lists and watches the Run's pods with the credentials of the current auth mode.
In client auth mode, grant the submitter the workflow and pod-log permissions they need.
Pods removed by pod GC make old requests unavailable, so keep a suitable pod retention window.

## Try the demo Job

On a disposable installation of a [supported release](compatibility.md), [the demo template](../examples/run-action-demo.yaml) exercises the UI without real credentials (its service account has only `create` and `patch` on `WorkflowTaskResult`):

```bash
kubectl -n argo set env deployment/argo-server ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=example.com
kubectl -n argo rollout status deployment/argo-server
kubectl -n argo apply -f examples/run-action-demo.yaml
```

Open **Jobs**, choose `run-action-demo`, and select **Run job**.
A prompt offers `https://example.com/` with code `DEMO-ONE`, then a second with ID `demo-2` and code `DEMO-TWO` 60 seconds later; the container stays up 90 more seconds so you can test navigation, reload, and the indicator.
Nothing waits for authorization: clicking the link completes no login.

```bash
kubectl -n argo delete workflows -l workflows.argoproj.io/workflow-template=run-action-demo
kubectl -n argo delete -f examples/run-action-demo.yaml
```

## Examples

[`examples/`](../examples/README.md) covers a link with no code (`run-actions-link-only.yaml`), a renewed request (`run-actions-renewed.yaml`), expiry (`run-actions-expiry.yaml`), a sidecar container (`run-actions-sidecar.yaml`), an unapproved host (`run-actions-unapproved-host.yaml`), and a GitHub device flow (`device-login-run-action.yaml`).
Submit from the UI so the marker annotation is copied onto the Run; a Run created with `kubectl` needs the annotations added by hand.
