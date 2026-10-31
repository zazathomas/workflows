#!/usr/bin/env bash
# Run only on a disposable cluster with argo-server in client auth mode.
set -euo pipefail

namespace="${ARGO_CONFORMANCE_NAMESPACE:-argo}"
# Pick a free local port instead of assuming 2746 is unused; a local argo server
# on the default port would otherwise receive the requests meant for the test cluster.
if [[ -z "${ARGO_CONFORMANCE_PORT:-}" ]]; then
  ARGO_CONFORMANCE_PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()')
fi
port="$ARGO_CONFORMANCE_PORT"
server="https://127.0.0.1:${port}"
name="fork-conformance-options"
cleanup() {
  kubectl -n "$namespace" delete workflowtemplate,configmap "$name" --ignore-not-found >/dev/null 2>&1 || true
  kubectl -n "$namespace" delete serviceaccount,role,rolebinding fork-conformance-reader --ignore-not-found >/dev/null 2>&1 || true
  if [[ -n "${forward_pid:-}" ]]; then kill "$forward_pid" 2>/dev/null || true; fi
}
trap cleanup EXIT

kubectl -n "$namespace" create configmap "$name" --from-literal='items=["a","b"]'
kubectl -n "$namespace" apply -f - <<EOF
apiVersion: argoproj.io/v1alpha1
kind: WorkflowTemplate
metadata:
  name: $name
  annotations:
    workflows.argoproj.io/parameter-sources: '{"region":{"configMap":{"name":"$name","key":"items"}}}'
spec:
  arguments:
    parameters:
      - name: region
  entrypoint: main
  templates:
    - name: main
      container:
        image: busybox:1.36
        command: [echo, ok]
EOF

kubectl -n "$namespace" apply -f - <<EOF
apiVersion: v1
kind: ServiceAccount
metadata:
  name: fork-conformance-reader
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: fork-conformance-reader
rules:
  - apiGroups: [argoproj.io]
    resources: [workflowtemplates]
    resourceNames: [$name]
    verbs: [get]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: fork-conformance-reader
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: fork-conformance-reader
subjects:
  - kind: ServiceAccount
    name: fork-conformance-reader
    namespace: $namespace
EOF

token=$(kubectl -n "$namespace" create token argo-server --duration=10m)
reader_token=$(kubectl -n "$namespace" create token fork-conformance-reader --duration=10m)
kubectl -n "$namespace" port-forward deployment/argo-server "$port:2746" >/tmp/argo-parameter-port-forward.log 2>&1 &
forward_pid=$!
ready=false
for _ in $(seq 1 90); do
  if curl -ksf --max-time 2 -H "Authorization: Bearer $token" "$server/api/v1/info" >/dev/null; then ready=true; break; fi
  if ! kill -0 "$forward_pid" 2>/dev/null; then break; fi
  sleep 2
done
if [[ "$ready" != true ]]; then
  echo "Argo Server did not answer on $server; port-forward log:" >&2
  sed -n '1,20p' /tmp/argo-parameter-port-forward.log >&2 || true
  exit 1
fi
base="$server/api/v1/extensions/parameter-options?namespace=$namespace&templateKind=WorkflowTemplate&templateName=$name&parameterName=region&configMapName=$name&configMapKey=items"
curl -ksSf --max-time 15 -H "Authorization: Bearer $token" "$base" | jq -e '.items == [{"label":"a","value":"a"},{"label":"b","value":"b"}]' >/dev/null
status=$(curl -ks -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $token" "${base}&configMapNamespace=other")
[[ "$status" == "403" ]]
status=$(curl -ks -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $reader_token" "$base")
[[ "$status" == "403" ]]
status=$(curl -ks -o /dev/null -w '%{http_code}' "$base")
[[ "$status" == "401" ]]
curl -ksSf --max-time 10 -H "Authorization: Bearer $token" "$server/api/v1/extensions/run-action-policy" | jq -e '.allowedHosts | type == "array"' >/dev/null
status=$(curl -ks -o /dev/null -w '%{http_code}' "$server/api/v1/extensions/run-action-policy")
[[ "$status" == "401" ]]
echo 'Client-auth parameter binding, ConfigMap RBAC denial, and anonymous policy access checks passed'
