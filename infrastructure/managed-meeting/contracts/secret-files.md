# Runtime secret-file contract

The privileged boot workflow renders these source files outside the repository,
registers each one in the rootless `chalk` user's Podman secret store, and then
removes the transient registration input. The source files and environment
files must be regular files, owned by the runtime user or root, and mode `0600`.
Neither the release manifest nor journal output may contain their contents.

| Source file                          | Podman secret                     | Container target                           |
| ------------------------------------ | --------------------------------- | ------------------------------------------ |
| `provider-bridge/api-server.crt`     | `chalk-api-provider-server-cert`  | `/run/chalk/provider-bridge/server.crt`    |
| `provider-bridge/api-server.key`     | `chalk-api-provider-server-key`   | `/run/chalk/provider-bridge/server.key`    |
| `provider-bridge/sync-client-ca.crt` | `chalk-api-provider-client-ca`    | `/run/chalk/provider-bridge/client-ca.crt` |
| `provider-bridge/sync-client.crt`    | `chalk-sync-provider-client-cert` | `/run/chalk/provider-bridge/client.crt`    |
| `provider-bridge/sync-client.key`    | `chalk-sync-provider-client-key`  | `/run/chalk/provider-bridge/client.key`    |
| `provider-bridge/api-server-ca.crt`  | `chalk-sync-provider-server-ca`   | `/run/chalk/provider-bridge/server-ca.crt` |
| `cloudflare/tunnel-token`            | `chalk-cloudflare-tunnel-token`   | `/run/secrets/tunnel-token`                |

The API server certificate must contain `chalk-api` in its DNS SAN. The Sync
client certificate identity must satisfy the API's SPIFFE trust-domain and
production-environment verifier. Certificate issuance and Podman secret
registration are deployment responsibilities; these artifacts do not create,
rotate, or inspect production credentials.
