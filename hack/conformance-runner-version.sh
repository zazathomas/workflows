#!/usr/bin/env bash
# Disposable kind only. Tests stock Argo, the PostgreSQL broker and the real runner.
set -euo pipefail
umask 077
root=$(cd "$(dirname "$0")/.." && pwd)
tag=${1:?usage: conformance-runner-version.sh TAG BROKER_IMAGE RUNNER_IMAGE}
broker_image=${2:?broker image required}
runner_image=${3:?runner image required}
cluster=${BROKER_E2E_KIND_CLUSTER:-broker-$(date +%s)-$$}
[[ "$cluster" =~ ^[a-z0-9][a-z0-9-]*$ ]]
kind_bin=${KIND:-kind}
work=$(mktemp -d "${BROKER_E2E_WORKDIR:-/tmp}/argo-broker.XXXXXX")
export KUBECONFIG="$work/kubeconfig"
pg="$cluster-postgres"
broker="$cluster-broker"
runner="$cluster-runner"
created_cluster=false
k() { kubectl --context "kind-$cluster" "$@"; }
cleanup() {
  status=$?
  if (( status != 0 )); then
    k -n builds get pods,workflows,workflowtasksets || true
    k -n builds logs deployment/workflow-controller --tail=70 || true
    docker logs --tail 70 "$runner" 2>&1 || true
    docker logs --tail 35 "$broker" 2>&1 || true
    for pod in $(k -n builds get pods -l workflows.argoproj.io/component=agent -o name 2>/dev/null); do
      k -n builds logs "$pod" --all-containers --tail=40 || true
    done
  fi
  docker rm -fv "$runner" "$broker" "$pg" >/dev/null 2>&1 || true
  if $created_cluster; then "$kind_bin" delete cluster --name "$cluster" >/dev/null 2>&1 || true; fi
  rm -rf "$work"
  exit "$status"
}
trap cleanup EXIT
if [[ ${BROKER_E2E_USE_EXISTING_KIND:-} == 1 ]]; then
  # Only an explicitly named, fresh disposable kind cluster is supported.
  "$kind_bin" get kubeconfig --name "$cluster" --internal > "$KUBECONFIG"
else
  created_cluster=true
  "$kind_bin" create cluster --name "$cluster" --kubeconfig "$KUBECONFIG" --wait 180s
fi

install="$work/install.yaml"
curl -fsSL --retry 3 "https://github.com/argoproj/argo-workflows/releases/download/$tag/namespace-install.yaml" -o "$install"
k create namespace builds --dry-run=client -o yaml | k apply -f - >/dev/null
k -n builds apply --server-side -f "$install" >/dev/null
# CRDs become discoverable asynchronously after the server-side apply. Wait
# before creating workflow RBAC or resources that validate against them.
k wait --for=condition=Established --timeout=120s \
  crd/workflows.argoproj.io crd/workflowtasksets.argoproj.io \
  crd/workflowtaskresults.argoproj.io >/dev/null
k -n builds rollout status deployment/workflow-controller --timeout=180s >/dev/null
# Stock controller/agent end to end. The Argo API server is not involved.
k -n builds scale deployment/argo-server --replicas=0 >/dev/null
k -n builds set env deployment/workflow-controller ARGO_EXECUTOR_PLUGINS=true >/dev/null
k -n builds apply -f "$root/deploy/runner-broker/workflow-rbac.yaml" >/dev/null
k -n builds create role controller-reconcile-tasksets --verb=patch --resource=workflowtasksets.argoproj.io/status --dry-run=client -o yaml | k -n builds apply -f - >/dev/null
k -n builds create rolebinding controller-reconcile-tasksets --role=controller-reconcile-tasksets --serviceaccount=builds:argo --dry-run=client -o yaml | k -n builds apply -f - >/dev/null

pg_image=postgres:17.4-alpine@sha256:7062a2109c4b51f3c792c7ea01e83ed12ef9a980886e3b3d380a7d2e5f6ce3f5
postgres_password=$(openssl rand -hex 24)
docker run -d --name "$pg" --network kind -e "POSTGRES_PASSWORD=$postgres_password" "$pg_image" >/dev/null
for _ in $(seq 1 45); do
  docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$pg" pg_isready -h 127.0.0.1 -U postgres >/dev/null
openssl rand -hex 32 > "$work/plugin-token"
chmod 644 "$work/plugin-token"
{
  printf 'BROKER_DATABASE_URL=postgres://postgres:%s@%s/postgres?sslmode=disable\n' "$postgres_password" "$pg"
  printf 'BROKER_NAMESPACE=builds\nBROKER_POOL=build\nBROKER_PLUGIN_TOKEN_FILE=/test/plugin-token\n'
} > "$work/broker.env"
docker run --rm --network kind --env-file "$work/broker.env" --mount "type=bind,src=$work/plugin-token,dst=/test/plugin-token,readonly" "$broker_image" migrate
join=$(docker run --rm --network kind --env-file "$work/broker.env" --mount "type=bind,src=$work/plugin-token,dst=/test/plugin-token,readonly" "$broker_image" mint 10m)

# Start with a temporary certificate so Docker assigns an address on the kind
# network. Replace it with a certificate containing that address before the
# broker serves requests. PostgreSQL and the broker publish no host ports.
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=runner-broker-test' \
  -addext 'subjectAltName=IP:127.0.0.1' -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$work/tls.key" -out "$work/tls.crt" 2> "$work/openssl.log"
chmod 644 "$work/tls.crt" "$work/tls.key" "$work/plugin-token"
docker run -d --name "$broker" --network kind --env-file "$work/broker.env" \
  -e BROKER_TLS_CERT=/test/tls.crt -e BROKER_TLS_KEY=/test/tls.key \
  --mount "type=bind,src=$work/tls.crt,dst=/test/tls.crt,readonly" \
  --mount "type=bind,src=$work/tls.key,dst=/test/tls.key,readonly" \
  --mount "type=bind,src=$work/plugin-token,dst=/test/plugin-token,readonly" "$broker_image" serve >/dev/null
broker_ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "kind").IPAddress}}' "$broker")
[[ "$broker_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]
docker stop "$broker" >/dev/null 2>&1 || true
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 1 -subj '/CN=runner-broker-test' \
  -addext "subjectAltName=IP:$broker_ip" -addext 'basicConstraints=critical,CA:TRUE' \
  -keyout "$work/tls.key" -out "$work/tls.crt" 2> "$work/openssl.log"
docker start "$broker" >/dev/null
base="https://$broker_ip:8443"

"$kind_bin" load docker-image --name "$cluster" "$broker_image" >/dev/null
k -n builds create secret generic runner-broker-plugin --from-file="token=$work/plugin-token" >/dev/null
k -n builds create configmap runner-broker-ca --from-file="ca.pem=$work/tls.crt" >/dev/null
python_script='import sys; p=sys.stdin.read().replace("registry.example.com/workflows-runner-broker:replace-me",sys.argv[1]).replace("https://runner-broker.runner-system.svc:8443",sys.argv[2]).replace("    args: [plugin]","    imagePullPolicy: Never\n    args: [plugin]").replace("      - name: BROKER_PLUGIN_TOKEN\n", "      - name: BROKER_CA_PEM\n        valueFrom:\n          configMapKeyRef: {name: runner-broker-ca, key: ca.pem}\n      - name: BROKER_PLUGIN_TOKEN\n"); print(p)'
python3 -c "$python_script" "$broker_image" "$base" < "$root/deploy/runner-broker/plugin.yaml" | k apply -f - >/dev/null
k -n builds rollout status deployment/workflow-controller --timeout=180s
# Restart so the controller has loaded the plugin ConfigMap before the first job.
k -n builds rollout restart deployment/workflow-controller >/dev/null
k -n builds rollout status deployment/workflow-controller --timeout=180s
printf '%s\n' '{"allowedRegistries":["docker.io"],"requireDigest":true,"allowRoot":false,"allowEgress":false}' > "$work/policy.json"
{
  printf 'DIND_MODE=privileged\nARGO_RUNNER_SERVER=%s\nARGO_RUNNER_JOIN_TOKEN=%s\n' "$base" "$join"
  printf 'ARGO_RUNNER_CREDENTIALS_DIR=/tmp/credentials\nSSL_CERT_FILE=/test-ca.crt\n'
} > "$work/runner.env"
docker run -d --name "$runner" --network kind --privileged --cgroupns=private --user 0 --env-file "$work/runner.env" \
  --mount "type=bind,src=$work/tls.crt,dst=/test-ca.crt,readonly" \
  --mount "type=bind,src=$work/policy.json,dst=/test-policy.json,readonly" \
  "$runner_image" run --once --policy /test-policy.json --flavour dind >/dev/null
rm -f "$work/runner.env"
for _ in $(seq 1 60); do
  if docker logs "$runner" 2>&1 | grep 'Enrolled as runner' >/dev/null; then break; fi
  [[ $(docker inspect -f '{{.State.Running}}' "$runner") == true ]]
  sleep 1
done
docker logs "$runner" 2>&1 | grep 'Enrolled as runner' >/dev/null
wf=$(k create -f "$root/examples/mixed-runner-broker.yaml" -o jsonpath='{.metadata.name}')
for _ in $(seq 1 120); do
  phase=$(k -n builds get workflow "$wf" -o jsonpath='{.status.phase}')
  if [[ $phase == Succeeded ]]; then break; fi
  if [[ $phase == Failed || $phase == Error ]]; then
    k -n builds get workflow "$wf" -o json | jq '.status.nodes | map_values({phase,message})'
    exit 1
  fi
  sleep 2
done
[[ "$phase" == Succeeded ]]
k -n builds get workflow "$wf" -o json | jq -e '
  .status.nodes | [.[] | select(.type == "Plugin" and .phase == "Succeeded") | .outputs.artifacts[] | select(.raw.data == "HELLO")] | length == 1'
docker exec "$pg" psql -U postgres -Atc "SELECT count(*) FROM runner_broker_jobs WHERE attempt=1 AND result->>'phase'='Succeeded'" | grep -x 1
printf 'PASS %s: stock Argo pod → remote Docker job → stock Argo pod (%s)\n' "$tag" "$wf"
