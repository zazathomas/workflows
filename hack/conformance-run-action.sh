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
name="fork-conformance-action"
workflow=""

cleanup() {
  if [[ -n "$workflow" ]]; then kubectl -n "$namespace" delete workflow "$workflow" --ignore-not-found --wait=false >/dev/null 2>&1 || true; fi
  kubectl -n "$namespace" delete workflowtemplate "$name" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete serviceaccount,role,rolebinding "$name" --ignore-not-found >/dev/null 2>&1 || true
  if [[ -n "${forward_pid:-}" ]]; then kill "$forward_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

kubectl -n "$namespace" port-forward deployment/argo-server "$port:2746" >/tmp/argo-run-action-port-forward.log 2>&1 &
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
  annotations:
    workflows-ui-action-marker: 'NEEDS_USER_ACTION:'
spec:
  serviceAccountName: $name
  entrypoint: main
  templates:
    - name: main
      container:
        image: busybox:1.36
        command: [sh, -c]
        args:
          - "echo 'NEEDS_USER_ACTION:{\"kind\":\"open-url\",\"id\":\"auth-1\",\"title\":\"Sign in\",\"url\":\"https://github.com/login/device\",\"code\":\"ABCD\"}'"
EOF

payload=$(printf '{"namespace":"%s","resourceKind":"WorkflowTemplate","resourceName":"%s","submitOptions":{"annotations":"workflows-ui-action-marker=NEEDS_USER_ACTION:,workflows-ui-action-container=main"}}' "$namespace" "$name")
response=$(curl -ksSf --max-time 30 -H 'Content-Type: application/json' -d "$payload" "$server/api/v1/workflows/$namespace/submit")
workflow=$(jq -er '.metadata.name' <<<"$response")
jq -e '.metadata.annotations["workflows-ui-action-marker"] == "NEEDS_USER_ACTION:"' <<<"$response" >/dev/null
if ! kubectl -n "$namespace" wait --for=jsonpath='{.status.phase}'=Succeeded "workflow/$workflow" --timeout=180s; then
  kubectl -n "$namespace" get workflow "$workflow" -o jsonpath='{.status.message}' >&2
  exit 1
fi
# The log endpoint returns JSON entries; the content after the marker is JSON.
curl -ksSf --max-time 20 "$server/api/v1/workflows/$namespace/$workflow/log?logOptions.container=main&grep=%5ENEEDS_USER_ACTION%3A" |
  jq -e 'select(.result.content | startswith("NEEDS_USER_ACTION:")) | .result.content | ltrimstr("NEEDS_USER_ACTION:") | fromjson | .url == "https://github.com/login/device"' >/dev/null
echo "Run-action submit annotation, pod log marker, and URL payload passed against upstream $version"
