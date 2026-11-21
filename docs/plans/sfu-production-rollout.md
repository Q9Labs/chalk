> **Plan, not authority.** This is one of our plans. It may be stale or wrong, and code, contracts and checks win wherever they disagree. Verify any claim here against code before relying on it.

# Deploying the Chalk SFU

Chalk SFU is the only media provider. The [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md) covers monitoring and alerts. Keep Tenant IDs, Space IDs, node addresses and environment values in private operator notes.

## Before deploying the retirement

1. Finish any live Cloudflare-backed Episodes. Check that their captures and provider cleanup have finished too. The new release can read those Episodes but cannot reconnect them or run their retired media operations.
2. Update any clients that create Spaces with an explicit old provider to send `chalk_sfu` or omit the field. Joining clients must advertise `chalk_sfu` in `X-Chalk-Media-Providers`; otherwise the API returns `409 media.client_unsupported`.
3. Save the previous release and its environment so that the [rollback](#undo) does not rely on the retired settings still being present. Keep Cloudflare TURN and storage credentials in place.

The API migration converts stored Cloudflare Space settings and Tenant defaults to `chalk_sfu`. It does not rewrite Episode snapshots, recordings or past audit entries.

## Verify the rollout

- Check `/readyz` and node cleanup debt. Create a Space and a public invite without specifying a media plane. Join each from a current client and verify that the new Episode binds to Chalk SFU. Run the recorded-call proof if capture is enabled.
- When all Chalk SFU nodes are drained or full, new Episodes return a retryable `503 media.unavailable`. Once a node is undrained, let the next readiness poll reach the API before trying again.
- `media-settings new-episodes --state off --operator <name> --reason <text>` blocks new Episodes and records an audit entry. It does not move or end a live Episode. Turn creation back on with `--state on`.

The deploy controller re-fetches the private API environment on every deploy. The API only reads it at start; editing the host file alone does not survive a deploy. Save any settings you change privately, distinguishing unset values from empty ones.

## Recording beside the node

Recording starts fast when a capture worker runs on the SFU node, and the on-demand fleet stays as the fallback. The design and its limits are in `docs/recording-transcription.md`. The node's CPU and memory per recorded Episode, the effect on the call and the number of concurrent recordings a node holds are measured in the pull request that added it; read those before changing the worker's limits in `infrastructure/sfu/deploy`.

To turn it on:

1. Create the environment's capture CA once (`certs <env> capture-ca`) and add its certificate to the provider bridge's client CA bundle.
2. Put `capture.conf` (`NODE_ID`, the bridge URL as `CONTROL_PLANE_URL`, and the TLS name as `SERVER_NAME`) and the bridge's server CA as `bridge-ca.crt` in the node's operator directory. `deploy` issues the node's worker identity (`certs <env> capture-worker <node id>`), checks that it is this node's, comes from the capture CA and has 14 days left, then builds and starts the worker after the node is ready.
3. Set `CHALK_SFU_COLOCATED_CAPTURE=true` and deploy the API. It registers the worker rows at start.

The undo is two independent steps, either of which is enough. Set `CHALK_SFU_COLOCATED_CAPTURE=false` and restart the API: the next claim and the next demand read go back to the fleet at once, and a capture a worker already holds keeps its heartbeats and commits and finishes. Or revoke one node's worker, which cuts it off at its next request, running captures included, without touching the others:

```sql
update recording_colocated_capture_workers
set state = 'revoked', ready = false, admission_open = false, ready_capacity = 0, revoked_at = now()
where environment = '<env>' and sfu_node = '<node id>';
```

To remove a worker from a node, delete `capture.conf` from its operator directory and deploy, which stops and removes the unit. Rolling the API back to an earlier release needs nothing else: the earlier release never reads the worker table, so the worker is simply unauthorized there. The migration's Down drops the table, which removes every registration.

A deploy of the node waits for zero allocations first, and a capture session holds one, so a recording in progress delays the deploy instead of being cut. `--force` cuts it: the worker's lease lapses and the capture retries from the last committed bundle on the fleet.

Constraints to know before the switch goes on:

- **The capture CA is not role-constrained.** An X.509 name constraint can limit a URI SAN by host, not by path, and every Chalk identity shares the host `chalkmeet.com`, so the CA cannot be limited to `/capture/`. Once the bridge's client bundle trusts it, whoever holds its key can sign an identity for any role that bundle serves, not only capture. Treat the key as a bridge credential. It lives in 1Password as "Chalk SFU <Environment> Capture CA Key" in the dev vault, and its certificate sits in the operator directory.
- **Revoking a worker stops its next request, not what it already holds.** Presigned object URLs the API issued to the worker stay valid until they expire.
- **The migration's Up takes ordinary locks.** It creates one table and three functions, and touches no existing table, so it blocks nothing that is running. How long it takes on production is not measured.
- **Bundles are assembled in memory.** The worker's unit sets a memory and CPU limit but no file-descriptor or disk budget, so a very large Episode is bounded by the memory limit alone.

## The node ships before any SDK that raises the offer size

The node accepts offers up to 256 KiB (`protocol.MaxSDPBytes`) and its request limit defaults to 384 KiB (`SFU_MAX_REQUEST_BYTES`; a node that sets it must stay at or above 384 KiB). Older SDKs keep offers under 64 KiB, so they work against either node. An SDK that lets an offer pass 64 KiB gets a 400 from a node with the old cap. So:

- The node ships first. `deploy-web` needs `deploy-managed` in CI, so a web cut cannot go out before the node. Do not publish a web-only cut by another path.
- Publish such an SDK to npm and cut mobile builds only after Promote's proof is green.
- Never roll a node back to the 64 KiB build while a web or SDK release that raises the limit is live. Roll back the web and the node together.

## Undo

Follow the [incident runbook](../operators/incident.md) to restore the previous compatible release and its saved environment. A runtime-only Release re-fetches configuration but keeps the current images; it does not undo a deploy. Keep web and SFU node versions compatible when rolling back.

A rollback does not send migrated Spaces back to Cloudflare. The migration preserves stored Episode history, and its Down restores the old audit trigger without reverting Space settings or later operator changes.
