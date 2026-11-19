# Approvals

Use the **Approvals** page (`/approvals/:namespace`) to decide a suspended step.
The Runs badge counts all active suspend gates in the authorized namespace or controller instance, not just the current inbox page.
An all-namespace count requires all-namespace Workflow list access.
The API returns no count while the first workflow snapshot or relevant compressed or offloaded node status is still pending.
Approve marks that step Succeeded; reject marks it Failed and lets the controller follow the workflow's normal failure and exit paths.

## Enable approvals

1. Choose one workflow namespace and install the [fork worker](deployment.md#fork-worker) and guarded state policy.
2. Set `ARGO_SERVER_APPROVAL_NAMESPACE` to the workflow namespace on the API and worker.
   Grant each its own namespace-scoped role from the deployment examples.
3. Bind the example `argo-approval-decider` role to your approver group or to the service accounts selected by SSO RBAC.
   The role grants `decide` on the virtual `platform.argoproj.io` resource `workflowapprovals` and read-only access to workflows.
   Grant `decide` with `resourceNames` if you need to constrain the grant to particular workflow names.

Client auth uses the Kubernetes identity returned by `SelfSubjectReview`.
SSO with RBAC uses the verified subject and the identity provider's issuer for attribution.
Unscoped approvals work in both modes; `group:`, `user:`, and `email:` approver restrictions require SSO claims, and `email:` requires a verified email.
Server auth and SSO without RBAC cannot approve.

## Protect a release gate

To use approvals for separation of duties, install the opt-in admission policies in the [protected namespace example](../deploy/approvals/protected-namespace.yaml) on Kubernetes 1.30 or newer.
Edit the publisher, stock controller, approval reconciler, namespace, and required mutex to match the installation before labeling the workflow namespace `platform.argoproj.io/protect-runs=true`.
Label the namespace `platform.argoproj.io/protect-extension-state=true` to protect the state records, and keep the policy ConfigMap in an administrator-controlled namespace.
The example admits one local mutex per protected namespace and requires it on every run, including a schedule or direct Kubernetes create.
Add it explicitly to the run or the CronWorkflow's `workflowSpec.synchronization` if the fork submit hook does not populate it.
For a semaphore, adapt the policy to check the exact ConfigMap/key/namespace and keep its capacity under administrator control.

Only the trusted publisher and stock controller may create runs in the example; only the stock controller and reconciler may update them.
Use trusted, reviewed templates for gates, and omit the stock suspend `duration` so it cannot resume the step independently.
Do not grant untrusted principals the ability to change those templates, CronWorkflows, role bindings, shared lock settings, the namespace label, or the workload identities that can reach the protected resource.
Treat the configured publisher, controller, approval reconciler, and cluster administrators as trusted.
Without the admission guard and restrictive RBAC, a suspend step is a UI convenience, not a release authorization boundary.

To roll back, remove the namespace label before removing the policies and role bindings, and back up the decision records before removing the namespace.
Removing the label removes enforcement; do not do this while protected workloads are accepting untrusted requests.

## Decide and audit a gate

`POST /api/v1/extensions/approvals/{namespace}/{workflow}/{nodeId}` requires this JSON body:

```json
{"decision":"approve","workflowUID":"b62549a2-96d7-4dea-8f3b-525cb9aaf540","startedAt":"2026-01-01T12:00:00Z","comment":"ship it"}
```

Use the Workflow's UID and the suspended node's `startedAt` value so a stale screen cannot approve another attempt.
The server reserves one immutable `argo-approval-*` ConfigMap per gate attempt before changing the workflow.
`202` means the decision is recorded for the worker to apply; `409` means you should reload the gate.
The record's `decision.json` contains the actor, decision, comment, gate identity, and time, and its state label shows `pending`, `applied`, or `stale`.
Keep record storage access separate from the decider role and export records to your audit system before deleting them.
Do not delete a pending record or remove a record for an active gate attempt.
Legacy decision annotations remain readable on existing runs; resolve those runs before turning on the admission policy, which rejects that annotation on protected writes.

## Job controls

Set these annotations on the Job; the fork submit path copies them onto the run.
For other launch paths, put the annotations on the Workflow itself.

| Annotation | Meaning |
| --- | --- |
| `approvals.argoproj.io/approvers` | Who may decide, for example `group:release-approvers,user:oncall`. Empty allows any identity with the dedicated action grant. |
| `approvals.argoproj.io/expiry` | Auto-deny after a Go duration, for example `30m`. Manual approval after expiry is refused even if the timer hasn't run. |
| `approvals.argoproj.io/auto-approve-after` | Auto-approve after a Go duration. Ignored unless `ARGO_SERVER_APPROVAL_AUTO_APPROVE=true`. |

If both timers have expired when evaluated, expiry takes precedence.
Disable automatic approval for jobs that require a human decision.
Use the `suspended` [notification trigger](notifications.md) to notify approvers.
See [`examples/approval-expiry.yaml`](../examples/approval-expiry.yaml) for Job annotations.
