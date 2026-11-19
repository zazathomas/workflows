#!/bin/sh
# Entry point of the containerised runner (Dockerfile.runner, docs/runners.md).
#
# Starts the inner Docker daemon in the operator-selected flavour, waits for
# it, then execs the argo-runner command with DOCKER_HOST pointing at the
# inner socket. Job containers never see that socket: the executor only ever
# mounts the per-job workspace volume.
#
#   DIND_MODE=rootless    (default) dockerd under rootlesskit as uid 1000.
#                         Requires the host to allow unprivileged user
#                         namespaces for rootlesskit (Ubuntu 23.10+ hosts
#                         need an AppArmor profile or the sysctl; see
#                         docs/runners.md).
#   DIND_MODE=privileged  dockerd as root; start with --privileged -u 0
#                         --cgroupns=private. Refused unless explicitly
#                         selected because a container escape then reaches
#                         the host.
#   DIND_MODE=sysbox     dockerd as root inside a Sysbox container; start
#                         with --runtime=sysbox-runc (no --privileged).

set -eu

mode="${DIND_MODE:-rootless}"
uid="$(id -u)"

log() { echo "[argo-runner-dind] $*"; }

case "$mode" in
  rootless)
    if [ "$uid" != "1000" ]; then
      log "ERROR: DIND_MODE=rootless must run as the image's unprivileged user (uid 1000, got $uid)."
      log "Start the container without -u; for privileged or sysbox flavours set DIND_MODE explicitly."
      exit 1
    fi
    ;;
  privileged)
    if [ "$uid" != "0" ]; then
      log "ERROR: DIND_MODE=privileged needs root; start with -u 0 --privileged --cgroupns=private."
      exit 1
    fi
    log "WARNING: DIND_MODE=privileged runs the inner dockerd as root with the"
    log "WARNING: container privileged. A job container escape can then reach the"
    log "WARNING: host. Prefer DIND_MODE=rootless, or DIND_MODE=sysbox with the"
    log "WARNING: sysbox-runc runtime; use --once on throwaway hosts."
    ;;
  sysbox)
    if [ "$uid" != "0" ]; then
      log "ERROR: DIND_MODE=sysbox needs root inside the Sysbox container; start with -u 0 --runtime=sysbox-runc."
      exit 1
    fi
    log "WARNING: DIND_MODE=sysbox runs dockerd as root inside the Sysbox VM-like"
    log "WARNING: container. Keep the runtime actually sysbox-runc: starting it"
    log "WARNING: without Sysbox degrades to a privileged container."
    ;;
  *)
    log "ERROR: unknown DIND_MODE '$mode' (use rootless, privileged, or sysbox)."
    exit 1
    ;;
esac

if [ "$mode" = rootless ]; then
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$uid}"
  dockerSocket="$XDG_RUNTIME_DIR/docker.sock"
else
  dockerSocket=/var/run/docker.sock
  # The bundled dind helper enables cgroup v2 nesting below its current
  # cgroup mount. Refuse the host namespace before invoking it.
  if [ -f /sys/fs/cgroup/cgroup.controllers ] && ! grep -qx '0::/' /proc/self/cgroup; then
    log "ERROR: rootful DinD needs a private cgroup namespace. Use --cgroupns=private with Docker."
    exit 1
  fi
fi

if [ -e "$dockerSocket" ] || [ -L "$dockerSocket" ]; then
  log "ERROR: $dockerSocket already exists. Do not mount a host Docker socket into DinD."
  exit 1
fi

# The bundled entrypoint sets up rootlesskit or delegates cgroup controllers
# before starting dockerd. The explicit command and socket prevent the stock
# entrypoint from also opening a TCP listener.
export DOCKER_HOST="unix://$dockerSocket"
dockerd-entrypoint.sh dockerd --host="$DOCKER_HOST" &
daemon_pid=$!

log "waiting for the inner Docker daemon on $dockerSocket"
i=0
until docker -H "$DOCKER_HOST" info >/dev/null 2>&1; do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    log "ERROR: the inner Docker daemon exited before it became ready; see its logs above"
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    log "ERROR: the inner Docker daemon did not become ready; see its logs above"
    exit 1
  fi
  sleep 1
done
log "inner Docker daemon ready"

# Hand the runner its own process group; the daemon keeps running in the
# background of this PID namespace supervisor.
exec /usr/local/bin/argo-runner "$@"
