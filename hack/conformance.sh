#!/usr/bin/env bash
# Run only against a disposable upstream controller/CRD installation of a tested release.
set -euo pipefail

namespace="${ARGO_CONFORMANCE_NAMESPACE:-argo}"
version="${ARGO_CONFORMANCE_VERSION:-the tested release}"
# Pick a free local port instead of assuming 2746 is unused; a local argo server
# on the default port would otherwise receive the requests meant for the test cluster.
if [[ -z "${ARGO_CONFORMANCE_PORT:-}" ]]; then
  ARGO_CONFORMANCE_PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
fi
port="$ARGO_CONFORMANCE_PORT"
server="https://127.0.0.1:${port}"
name="fork-conformance"
workflow=""

cleanup() {
  if [[ -n "$workflow" ]]; then kubectl -n "$namespace" delete workflow "$workflow" --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
  kubectl -n "$namespace" delete workflowtemplate,cronworkflow "$name" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete serviceaccount,role,rolebinding "$name" --ignore-not-found >/dev/null 2>&1 || true
  if [[ -n "${forward_pid:-}" ]]; then kill "$forward_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

kubectl -n "$namespace" port-forward deployment/argo-server "$port:2746" >/tmp/argo-conformance-port-forward.log 2>&1 &
forward_pid=$!
ready=false
for _ in $(seq 1 90); do
  if curl -ksf --max-time 2 "$server/api/v1/info" >/dev/null; then ready=true; break; fi
  if ! kill -0 "$forward_pid" 2>/dev/null; then break; fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  echo "Argo Server did not answer on $server; port-forward log:" >&2
  sed -n '1,20p' /tmp/argo-conformance-port-forward.log >&2 || true
  exit 1
fi
curl -ksf --max-time 10 "$server/api/v1/info" >/dev/null
curl -ksf --max-time 10 "$server/" | grep -q '<html'

kubectl -n "$namespace" apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: $name
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: $name
rules:
  - apiGroups: [argoproj.io]
    resources: [workflowtaskresults]
    verbs: [create, patch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: $name
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: $name
subjects:
  - kind: ServiceAccount
    name: $name
    namespace: $namespace
---
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: $name
spec:
  serviceAccountName: $name
  entrypoint: main
  templates:
  - name: main
    container:
      image: busybox:1.36
      command: [sh, -c]
      args: [echo fork-conformance]
EOF

payload=$(printf '{"workflow":{"metadata":{"generateName":"fork-conformance-"},"spec":{"workflowTemplateRef":{"name":"%s"}}}}' "$name")
workflow=$(curl -ksSf --max-time 30 -H 'Content-Type: application/json' -d "$payload" "$server/api/v1/workflows/$namespace" | jq -er '.metadata.name')
curl -ksf --max-time 10 "$server/api/v1/workflows/$namespace/$workflow" | jq -e '.metadata.name' >/dev/null
watch_response=$(curl -ks --max-time 6 --no-buffer "$server/api/v1/workflow-events/$namespace?listOptions.fieldSelector=metadata.name%3D$workflow&listOptions.resourceVersion=0" 2>/dev/null || true)
if [[ "$watch_response" != *"$workflow"* ]]; then
  echo 'Workflow watch endpoint returned no matching event' >&2
  exit 1
fi
kubectl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$workflow" --timeout=300s
curl -ksf --max-time 10 "$server/api/v1/workflows/$namespace/$workflow" | jq -e '.status.phase == "Succeeded"' >/dev/null
log_response=$(curl -ksf --max-time 20 "$server/api/v1/workflows/$namespace/$workflow/log?logOptions.container=main")
if [[ "$log_response" != *fork-conformance* ]]; then
  echo "Workflow log API returned no expected output: $log_response" >&2
  exit 1
fi

kubectl -n "$namespace" apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: CronWorkflow
metadata:
  name: $name
spec:
  schedules: ['0 0 * * *']
  suspend: true
  workflowSpec:
    serviceAccountName: $name
    entrypoint: main
    templates:
      - name: main
        container:
          image: busybox:1.36
          command: [echo, fork-conformance]
EOF
curl -ksf --max-time 10 "$server/api/v1/cron-workflows/$namespace/$name" | jq -e '.metadata.name == "fork-conformance"' >/dev/null
# A server-mode caller must not be able to use the custom parameter source endpoint.
status=$(curl -ks -o /dev/null -w '%{http_code}' "$server/api/v1/extensions/parameter-options?namespace=$namespace&url=https://example.com")
[[ "$status" == "403" ]]
policy=$(curl -ksf --max-time 10 "$server/api/v1/extensions/run-action-policy")
echo "$policy" | jq -e '.allowedHosts | type == "array"' >/dev/null
if [[ -n "${ARGO_CONFORMANCE_ACTION_ALLOW_HOSTS:-}" ]]; then
  echo "$policy" | jq -e --arg host "$ARGO_CONFORMANCE_ACTION_ALLOW_HOSTS" '.allowedHosts | index($host) != null' >/dev/null
fi
status=$(curl -ks -o /dev/null -w '%{http_code}' -X POST "$server/api/v1/extensions/run-action-policy")
[[ "$status" == "405" ]]
echo "Fork API/UI, workflow execution, watch, logs, CronWorkflow, action policy, and server-mode parameter isolation passed against upstream $version"
