# Remote runner threat model

The [standalone runner broker](runner-broker.md) and its PostgreSQL database are trusted components.
Each broker deployment serves one approved namespace and pool.
A broker or plugin credential compromise allows job submission within that trust domain.

- The stock Argo agent authenticates to the loopback plugin with its per-pod token; the plugin uses a separate scoped credential to call the broker over verified HTTPS.
- Restrict pod creation, pod patches, Secret references, agent pod access, plugin ConfigMaps, and `workflowtasksets/status` in workflow namespaces. Users who can obtain the plugin credential can submit directly to the broker.
- Enrollment consumes a hashed, expiring, single-use pool token in the same transaction that stores the worker key. Workers sign requests with Ed25519; the broker records nonces in PostgreSQL so replicas share replay protection.
- A worker can read and report results for its current claims. A later attempt replaces its claim token, and the broker rejects stale writes. Jobs have at-least-once execution semantics.
- The broker accepts bounded inline artifacts rather than user-selected storage endpoints. It does not resolve Kubernetes Secrets. Neither the broker nor remote workers receive Kubernetes credentials.
- Workers run pinned images with a local registry policy, no job socket mount, dropped capabilities, and an isolated network by default. A Docker daemon and its host remain part of the trust boundary; use dedicated or disposable workers for untrusted jobs.
- Docker volume limits depend on the storage backend. Test that workspace, CPU, memory, PID, and network limits are enforced on the chosen runtime.
- Never log request queries, bodies, or credentials. Artifact and log requests carry job tokens in the query for runner protocol compatibility.
