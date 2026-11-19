# Per-Job concurrency and on-conflict

The server adds a workflow-level lock when you submit a Job with `workflows.argoproj.io/max-concurrent-runs`.
It preserves other synchronization locks on the workflow.

For a limit of one, set the annotation to `"1"`; the server adds a mutex.
For a higher limit, create an administrator-owned ConfigMap named `argo-job-concurrency` in the workflow namespace.
Set the data key `job-wt-<template name>`, `job-cwt-<template name>` or `job-cron-<cron name>` to the configured limit as a string.
The stock controller enforces the semaphore; the ConfigMap value determines its capacity.

Use `workflows.argoproj.io/on-conflict` to choose how the server handles an existing run:

- `queue` (default): the controller queues runs when the synchronization lock is full.
- `replace` is best-effort: the server creates the new run and attempts to stop the older runs in the same namespace and controller instance.
  A stop failure is logged with both run names; the new run already exists and is still subject to its lock.
- `reject` is best-effort: the server checks for an existing active run before creating a new one.
  The check is not atomic across submissions; only the controller's lock enforces capacity.

Neither dry-run option changes an existing run.
Scheduled CronWorkflow runs and workflows created outside server submission need explicit `spec.synchronization`.
Do not use a user-editable annotation as a tenant quota.
The [protected namespace example](approvals.md#protect-a-release-gate) requires an operator-selected mutex at admission, including on direct and scheduled creates.

See [the replacement example](../examples/job-concurrency-replace.yaml).
