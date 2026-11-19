#!/bin/sh
# Smoke-test the built runner image's real entrypoint on a disposable daemon.
set -eu

if [ "${RUNNER_DIND_SELF_TEST:-}" = 1 ]; then
  test "$DOCKER_HOST" = unix:///var/run/docker.sock
  if netstat -lnt | grep -Eq ':(2375|2376)[[:space:]]'; then
    echo 'The inner Docker daemon must not open a TCP listener' >&2
    exit 1
  fi
  image=docker.io/library/busybox@sha256:a7dbc319b1438115a207e11930dc4bb3e643dcb3ec0bdd694bb36cd8fad289ec
  docker run --rm --network=none --read-only --user 65534:65534 \
    --cap-drop=ALL --security-opt=no-new-privileges \
    --memory=64m --cpus=0.5 --pids-limit=32 "$image" sh -ec '
      if [ -e /sys/fs/cgroup/cgroup.controllers ]; then
        test "$(head -n1 /sys/fs/cgroup/memory.max)" = 67108864
        test "$(head -n1 /sys/fs/cgroup/pids.max)" = 32
        set -- $(head -n1 /sys/fs/cgroup/cpu.max)
        test "$((2 * $1))" -eq "$2"
      else
        test "$(head -n1 /sys/fs/cgroup/memory/memory.limit_in_bytes)" = 67108864
        test "$(head -n1 /sys/fs/cgroup/pids/pids.max)" = 32
        cpu=$(find /sys/fs/cgroup -name cpu.cfs_quota_us | head -n1)
        test -n "$cpu"
        test "$((2 * $(head -n1 "$cpu")))" -eq "$(head -n1 "${cpu%/*}/cpu.cfs_period_us")"
      fi
      echo "DinD job started with CPU, memory and PID limits"
    '
  exit 0
fi

image=${1:?usage: hack/test-runner-dind.sh RUNNER_IMAGE}
script=$(cd -- "$(dirname -- "$0")" && pwd)/$(basename -- "$0")
exec docker run --rm --privileged --cgroupns=private --user 0 \
  -e DIND_MODE=privileged -e RUNNER_DIND_SELF_TEST=1 \
  --mount "type=bind,src=$script,dst=/usr/local/bin/argo-runner,readonly" "$image"
