#!/usr/bin/env bash
# Run the full conformance suite against one registered upstream release, using a
# disposable kind cluster. Never point this at a shared cluster: it deletes the
# cluster it creates.
#
# Usage: conformance-version.sh <tag> [image]
#   tag    release listed in hack/upstream-versions.json
#   image  local server image to test, default workflows:compatibility
#
# Environment:
#   KEEP=1           keep the kind cluster for debugging
#   KIND_CLUSTER     reuse a cluster name instead of deriving one from the tag
set -euo pipefail

cd "$(dirname "$0")/.."

tag="${1:-}"
image="${2:-workflows:compatibility}"
[[ -n "$tag" ]] || { echo "usage: $0 <tag> [image]" >&2; exit 2; }

read -r install_sha256 commit < <(python3 - "$tag" <<'PY'
import json
import pathlib
import sys

registry = json.loads(pathlib.Path("hack/upstream-versions.json").read_text())
entries = {entry["tag"]: entry for entry in registry["versions"]}
entry = entries.get(sys.argv[1])
if entry is None:
    sys.exit(f"{sys.argv[1]} is not registered in hack/upstream-versions.json")
print(entry["installManifestSha256"], entry["commit"])
PY
)

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  else
    shasum -a 256 "$@"
  fi
}

kind_bin="${KIND:-}"
if [[ -z "$kind_bin" ]]; then
  kind_bin="$(command -v kind || true)"
fi
if [[ -z "$kind_bin" ]]; then
  kind_bin="$(go env GOPATH)/bin/kind"
fi
[[ -x "$kind_bin" ]] || { echo "kind not found; run: go install sigs.k8s.io/kind@v0.30.0" >&2; exit 1; }

cluster="${KIND_CLUSTER:-workflows-conformance-${tag//[^a-z0-9]/-}}"
kubeconfig="$(mktemp)"
workdir="$(mktemp -d)"

diagnose() {
  echo "=== $tag: diagnostics" >&2
  kubectl -n argo get pods,workflows,workflowtemplates 2>&1 | tail -40 >&2 || true
  kubectl -n argo logs deployment/argo-server --tail=60 2>&1 >&2 || true
  kubectl -n argo logs deployment/workflow-controller --tail=60 2>&1 >&2 || true
}

cleanup() {
  local status=$?
  if [[ $status -ne 0 ]]; then
    diagnose
  fi
  rm -rf "$workdir"
  if [[ "${KEEP:-0}" == "1" ]]; then
    echo "Keeping cluster $cluster; kubeconfig at $kubeconfig"
    return
  fi
  rm -f "$kubeconfig"
  "$kind_bin" delete cluster --name "$cluster" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=== $tag ($commit): creating cluster $cluster"
"$kind_bin" create cluster --name "$cluster" --wait 180s --kubeconfig "$kubeconfig"
export KUBECONFIG="$kubeconfig"

"$kind_bin" load docker-image "$image" --name "$cluster"

install="$workdir/install.yaml"
curl -fsSL --retry 3 "https://github.com/argoproj/argo-workflows/releases/download/${tag}/install.yaml" -o "$install"
echo "${install_sha256}  ${install}" | sha256 -c - >/dev/null || {
  echo "install.yaml for $tag does not match the registered checksum" >&2
  exit 1
}

kubectl create namespace argo
kubectl apply --server-side -n argo -f "$install"
kubectl -n argo rollout status deployment/workflow-controller --timeout=360s

# The image under test replaces only the server; the controller, executor, and
# CRDs stay on the registered release.
kubectl -n argo set image deployment/argo-server argo-server="$image"
kubectl -n argo set env deployment/argo-server ARGO_SERVER_RUN_ACTION_ALLOW_HOSTS=github.com
kubectl -n argo patch deployment/argo-server --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":["server","--auth-mode=server"]}]'
kubectl -n argo rollout status deployment/argo-server --timeout=360s

export ARGO_CONFORMANCE_VERSION="$tag"
echo "=== $tag: server mode API, execution, logs, and run actions"
ARGO_CONFORMANCE_ACTION_ALLOW_HOSTS=github.com bash hack/conformance.sh
bash hack/conformance-run-action.sh

echo "=== $tag: client mode parameter sources and policy access"
kubectl -n argo patch deployment/argo-server --type=json \
  -p '[{"op":"replace","path":"/spec/template/spec/containers/0/args","value":["server","--auth-mode=client"]}]'
kubectl -n argo set env deployment/argo-server ARGO_SERVER_PARAMETER_SOURCE_ALLOW_HOSTS=catalog.example.com
kubectl -n argo rollout status deployment/argo-server --timeout=360s
bash hack/conformance-parameter.sh

echo "=== $tag: passed"
