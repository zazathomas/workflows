#!/usr/bin/env bash
# Promote two previously verified platform manifests. Print only the index digest.
set -euo pipefail
image=${1:?image repository is required}
tag=${2:?destination tag is required}
amd=${3:?amd64 digest is required}
arm=${4:?arm64 digest is required}
[[ $amd =~ ^sha256:[0-9a-f]{64}$ && $arm =~ ^sha256:[0-9a-f]{64}$ && $amd != "$arm" ]]
[[ $tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]]
check() {
  jq -e --arg amd "$amd" --arg arm "$arm" '
    (.manifests | length == 2) and
    any(.manifests[]; .digest == $amd and .platform.os == "linux" and .platform.architecture == "amd64") and
    any(.manifests[]; .digest == $arm and .platform.os == "linux" and .platform.architecture == "arm64")
  ' >/dev/null
}
docker buildx imagetools create --dry-run "$image@$amd" "$image@$arm" | check
docker buildx imagetools create --tag "$image:$tag" "$image@$amd" "$image@$arm" >&2
manifest=$(docker buildx imagetools inspect "$image:$tag" --format '{{json .Manifest}}')
check <<<"$manifest"
jq -er '.digest | select(test("^sha256:[0-9a-f]{64}$"))' <<<"$manifest"
