# Remote Linux runner operations

Deploy the [standalone broker and stock Argo plugin](runner-broker.md) before enrolling workers.
Set the runner's server URL to the broker's HTTPS origin and verify its certificate.
Workers use single-use, pool-scoped join tokens, then sign requests with their enrolled Ed25519 key.

## Containerised runner (DinD)

`Dockerfile.runner` builds one image with the runner binary and a Docker daemon. The default flavour is rootless DinD; the operator picks the flavour at start with `DIND_MODE`:

| Mode | Start with | Notes |
| --- | --- | --- |
| `rootless` (default) | UID 1000 with mount and user namespace support | dockerd runs under RootlessKit. Docker's standard rootless DinD launch still uses a privileged outer container; use a runtime that grants the required capabilities if you cannot allow that. Verify cgroup delegation before relying on job resource limits. |
| `privileged` | `-u 0 --privileged --cgroupns=private -e DIND_MODE=privileged` | Works with Linux containers on Docker Desktop for macOS and with Docker Engine on Linux. Use on a trusted, dedicated or disposable host: a container escape can reach the Docker host. |
| `sysbox` | `-u 0 --runtime=sysbox-runc -e DIND_MODE=sysbox` | dockerd runs inside Sysbox without `--privileged`. Requires a Linux host with Sysbox installed. |

The runner starts the bundled Docker entrypoint to prepare nested cgroups before accepting jobs.
Use a private cgroup namespace, and do not mount the host cgroup tree or Docker socket into DinD.
The inner daemon listens only on its Unix socket, which the executor never mounts into jobs.
On Linux, rootless mode needs unprivileged user namespaces and may require the RootlessKit AppArmor profile; see [Docker's rootless notes](https://docs.docker.com/engine/security/rootless/tips/).
To check a rebuilt image on either host, run `hack/test-runner-dind.sh <runner-image>` on a disposable Docker host.
The check starts a real job and verifies CPU, memory, and PID limits inside it.
The image ships the most restrictive policy (no registries allowed); mount your own at `/etc/argo-runner/policy.json` (examples in [`deploy/runners/`](../deploy/runners/)).
Enrolment persists in the `runner-state` volume.

## Running the runner natively

1. Create an unprivileged user with rootless Docker; the runner needs only that user's Docker socket.
2. Install `dist/argo-runner` (from `make runner` or the released image) as `/usr/local/bin/argo-runner`.
3. Write `/etc/argo-runner/policy.json` and provision `/etc/argo-runner` (owned by the runner user, `0700`).
4. Mint a join token and enrol once.
5. Run the claim loop under systemd:

```ini
[Unit]
Description=Argo Workflows remote runner
After=docker.service
Wants=docker.service

[Service]
User=argo-runner
Group=argo-runner
ExecStart=/usr/local/bin/argo-runner run --policy /etc/argo-runner/policy.json
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/etc/argo-runner
CapabilityBoundingSet=
AmbientCapabilities=

[Install]
WantedBy=multi-user.target
```

`--once` claims and runs a single job, then exits; use it on throwaway hosts.
Runner environment variables are listed in [environment variables](environment-variables.md).

## Policy file

The operator owns the policy; it can only restrict what the control plane requests.

```json
{
  "allowedRegistries": ["docker.io"],
  "requireDigest": true,
  "allowRoot": false,
  "allowEgress": false,
  "runtime": "",
  "jobSigners": [],
  "cosignKeys": [],
  "cosignPath": "cosign",
  "maxCPUMillis": 4000,
  "maxMemoryMB": 8192,
  "defaultCPUMillis": 1000,
  "defaultMemoryMB": 1024,
  "workspaceMB": 1024
}
```

- `cosignKeys`/`cosignPath`/`cosignTimeout`: verify every job image with the operator-installed `cosign` binary before the container is created. Fail closed (missing binary, timeout, or no key verifying rejects the job), and images must be digest-pinned. Verification does not require a transparency log entry, so the pinned keys are the whole trust anchor.
- `allowEgress`: no destination allow-list. A job with egress reaches every network the runner host can, including `169.254.169.254` and private ranges; the runner warns when it is on.
- `runtime`: the only way to select a sandbox runtime (the control plane has no field for it).
- `jobSigners`: pinned job-spec signer keys (see [the gate](#signed-job-specs-gate)).

Sandbox presets ship in [`deploy/runners/`](../deploy/runners/): `policy-gvisor.json` (`runsc`), `policy-sysbox.json` (`sysbox-runc`), `policy-kata.json` (`kata-runtime`), all requiring digest-pinned images with egress off.
Install the runtime on the host, then mount the preset as `/etc/argo-runner/policy.json`.

## Signed job specs (gate)

`argo-runner gate --server https://runner-broker.example.com --listen 127.0.0.1:8081 --key /etc/argo-runner/gate-key` runs an operator-local proxy that signs every claimed job spec with an Ed25519 key (printed on start).
Point the runner at the gate (`argo-runner run --server http://127.0.0.1:8081`) and pin the printed public key in `jobSigners`; the runner then refuses any job whose spec is not signed and fails the node with `job spec has no valid signature`.
The gate signs what the broker returned, including a forged spec from a compromised server, so it protects the transport between gate and runner, not against a compromised control plane.
A claim response larger than 64 MiB is passed through unsigned (and therefore rejected).
Rotation: start a second gate with a new key, add its public key to `jobSigners`, retire the old one.
