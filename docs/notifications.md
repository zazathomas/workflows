# Notifications

argo-server delivers notifications when runs change state, when they wait on a human, and when the runner fleet's health changes.
You opt in per Job with annotations; destinations (transports and credentials) live in a per-namespace ConfigMap that also supplies defaults for Jobs that do not opt in.
The fork worker persists one delivery intent per observed run event and destination in Kubernetes, and counts delivery attempts in `argo_notify_deliveries_total` ([metrics](fleet-metrics.md)).
An intent survives worker restarts; the receiver can see duplicates if a successful send loses its acknowledgement before the worker records the result.

## Opt in

Put the annotations on the Job (the WorkflowTemplate, ClusterWorkflowTemplate, or CronWorkflow).
The submit path copies them onto every run it starts, so `kubectl get workflow` shows what a run opted into; you can also set them on a run directly, and the workflow's own values win.

| Annotation | Values |
| --- | --- |
| `notifications.argoproj.io/destinations` | Comma-separated destination names |
| `notifications.argoproj.io/triggers` | `started`, `succeeded`, `failed`, `error`, `suspended`, `waiting`, `duration-exceeded` |
| `notifications.argoproj.io/on-<trigger>` | Destination names for one trigger (replaces the general list for it) |
| `notifications.argoproj.io/max-duration` | Go duration (`2h`); `duration-exceeded` fires when a run is older |
| `notifications.argoproj.io/suppress-success` | `true` stops success notifications for this Job |

| Trigger | Fires when |
| --- | --- |
| `started` | The run started (phase Running) |
| `succeeded` | The run finished successfully |
| `failed` | The run failed |
| `error` | The run errored (retryable; the UI offers retry) |
| `suspended` | A step waits on a human (once per step) |
| `waiting` | The run waits on a synchronization lock |
| `duration-exceeded` | The run is older than `max-duration` (checked every 30 seconds) |

```yaml
metadata:
  annotations:
    notifications.argoproj.io/destinations: "team-slack"
    notifications.argoproj.io/triggers: "started,succeeded,failed,error,suspended,waiting"
    notifications.argoproj.io/on-failed: "oncall-pagerduty,team-slack"
    notifications.argoproj.io/max-duration: "2h"
```

## Destinations

Destinations live in a ConfigMap named `argo-notifications` in each namespace that runs workflows.
Every key is a destination name holding transport JSON, except the two reserved keys `defaults` and `runner-health`.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: argo-notifications
  namespace: team-a
data:
  team-slack: |
    {"type": "slack", "url": {"secret": {"name": "slack-hook", "key": "url"}}}
  oncall-pagerduty: |
    {"type": "pagerduty", "routingKey": {"secret": {"name": "pd", "key": "routing-key"}}}
  webhook: |
    {"type": "webhook", "url": {"value": "https://example.com/hook"}, "headers": {"X-Token": "…"}}
  email: |
    {"type": "smtp", "host": "smtp.example.com", "port": 465, "from": "argo@example.com", "to": ["team@example.com"], "username": "argo", "password": {"secret": {"name": "smtp", "key": "password"}}}
  defaults: |
    {"destinations": ["team-slack"], "triggers": ["failed", "error"]}
```

`defaults` fills in destinations and triggers (and `maxDuration`) for runs whose Job did not opt in; a namespace with neither annotations nor defaults sends nothing.

- `slack`: posts to a Slack incoming-webhook URL.
- `webhook`: posts `{trigger, subject, body, workflow}` to any HTTPS URL, with optional `headers`.
- `pagerduty`: Events v2, either a full `url` or a `routingKey` (which uses `https://events.pagerduty.com/v2/enqueue`); the dedup key is the run UID plus trigger.
- `smtp`: one plain-text mail over TLS on port 465 (implicit, default) or 587 (STARTTLS), with `host`, `from`, `to`, and optional `username`/`password`.

### Credentials

Any credential can be inline (`{"value": "…"}`) or read from a Secret (`{"secret": {"name": "...", "key": "..."}}`).
A referenced Secret must be in the ConfigMap's namespace and carry `notifications.argoproj.io/allowed: "true"`; a missing, unlabelled, or oversized Secret fails that delivery with a visible error.
Secrets are read at delivery time, so rotation is immediate.

The [fork worker](deployment.md#fork-worker) reads labeled Secrets using namespace-scoped, named RBAC grants.
The API's optional test-send [Role](../deploy/notifications/argo-server-notify-rbac.yaml) grants no Secret access.

## Egress policy

Webhook transports must use HTTPS, cannot embed credentials in the URL, and their hostname must be in `ARGO_SERVER_NOTIFICATION_ALLOW_HOSTS`.
SMTP hosts are checked against the same list and must use TLS (465 or 587).
The list takes exact hostnames without scheme, port, or wildcard; an empty list fails every delivery closed, and a malformed entry stops the worker at startup.
There is no private-network block: listing `smtp.internal` deliberately lets the server reach it.

## Test send

```bash
curl -X POST "$ARGO_SERVER/api/v1/extensions/notifications/team-a/test" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"destination": "team-slack"}'
```

Grant the caller `send` on the virtual resource `notificationtests` in API group `platform.argoproj.io` and `get` on that namespace's `argo-notifications` ConfigMap.
You can use `resourceNames` to limit the grant to named destinations.
Use client auth or SSO with RBAC; server auth mode is refused.
The namespace goes in the path, not the JSON body; the old `/notifications/test` URL is no longer accepted.
Test sends have a per-server rate and concurrency limit and return `202` with the queued record name.
Check that record's `platform.argoproj.io/notification-state` label for progress.

## Delivery records and retention

The `argo-notification-*` ConfigMaps hold queued, sent, or dead-letter state and no credential values or webhook URLs.
The worker leases a queued record, retries failures with backoff up to six attempts, and dead-letters records whose destination was removed or changed.
Credential rotation through the same Secret reference is picked up at send time.
Protect the records with the admission binding and keep a namespace quota and retention policy; remove terminal records only after their source workflow can no longer generate the same event.
A watch can coalesce rapid workflow updates before an intent exists; at-least-once delivery applies to persisted intents within the retry budget.
