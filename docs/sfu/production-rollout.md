# Moving production to the own SFU

Judgment for running production on the own SFU, and for undoing it. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git. Watch signals and alerts are in the [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md).

## Production plane

Production runs on the own SFU as the only plane for new Episodes. Cloudflare is off the production path: a new Episode that no node can take is refused with a retryable `503 media.unavailable` instead of starting on Cloudflare (`CHALK_SFU_CLOUDFLARE_OVERFLOW=false`), and a live Episode never moves to Cloudflare. The Cloudflare adapter stays in the code behind the media plane port, and its one production use is the undo: the database kill switch that sends new Episodes back to it. A second own-SFU node as a spare (the 6 USD tier) is planned, so new Episodes have room while one node is down or full.

The production switch is one deploy that sets these lines, then one restart:

1. `CHALK_DEFAULT_MEDIA_PLANE=chalk_sfu` makes the own SFU the plane of every Space and Tenant that stores no plane of its own, and `CHALK_SFU_ALLOWED_SPACES=*` lets every Space use it. A Space that stores `cf_sfu` stays on Cloudflare until `media-settings set --plane chalk_sfu` or `inherit` moves it.
2. `CHALK_SFU_ENABLED=true` and `CHALK_SFU_CAPTURE_ENABLED=true`. The API refuses to start with the own SFU as the default and capture off, because recording and transcription of an own-SFU Episode need capture, and a Space can turn them on at any time.
3. `CHALK_SFU_CLOUDFLARE_OVERFLOW=false`.
4. `CHALK_NEW_SPACE_MEDIA_PLANE=chalk_sfu` and `CHALK_PUBLIC_INVITE_DEFAULT_MEDIA_PLANE=chalk_sfu`. A Space created with no plane, and every public-invite Space, stores its plane when it is created. An unset `CHALK_NEW_SPACE_MEDIA_PLANE` follows the default, but a line that still says `cf_sfu` keeps new Spaces landing on Cloudflare whatever the default says, and the public-invite line is always set, so change both.
5. The Cloudflare application settings (`CHALK_CLOUDFLARE_REALTIME_APP_ID` and `CHALK_CLOUDFLARE_REALTIME_APP_SECRET`) stay, because the kill switch target and Episodes already bound to Cloudflare need them.
6. The transcription dispatcher has `CODESWITCH_PROVIDER=mai` and its OpenRouter token, because without them an Auto-language job fails as retryable and the transcript never arrives.

Start only when `/readyz` shows zero sessions, allocations and cleanup debt, so no real class is live. Then read `/healthz`, and `media-settings get --tenant <tenant> --space <space>` on a throwaway Space: it must report `chalk_sfu`. Run the own-SFU proofs and the kill-switch drill alone on the node.

The web SDK declares `chalk_sfu` since 5.5.0, and the mobile app since the build tagged `mobile-v3.0.6-b40`. A client that declares nothing still gets a Cloudflare call while the Cloudflare application is configured, and that is the one Cloudflare use besides the undo. `CHALK_SFU_CLIENT_SUNSET` turns it into 409 `media.client_unsupported` after the date, so set it once the old builds are gone.

Write each change's undo before making it. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git.

## The production flip

Order matters, because the release that ran in production before the kill switch cannot start with `chalk_sfu` as the default.

1. Deploy the release that carries the kill switch table (the migration only adds tables). Change no setting in that deploy. Confirm `media-settings new-episodes` reads `on`.
2. Check that no call is live: a deploy restarts the API and drops every socket. Save the current lines of the list above privately, change them in the private API environment, and deploy once. The deploy re-fetches the environment and restarts the API.
3. Confirm it worked, in this order:
   - `/readyz` is healthy and the node reports no cleanup debt.
   - `media-settings get` on a throwaway Space reports `chalk_sfu`.
   - One new Episode from a current client binds to the own SFU: its `sdk.call_stats` provider is `chalk_sfu`, and the API log has no request to Cloudflare's SFU API for it.
   - A recorded Episode finalizes its Recording.
   - A Space created with no plane, and a public invite, both report `chalk_sfu`.
   - Overflow is off: `POST /v1/drain` on every node, then create a fresh Episode from a current client. It must be refused with a retryable `503 media.unavailable`, and the API log must have no request to Cloudflare's SFU API for it. Then `POST /v1/undrain` on every node and confirm `/readyz` reports `draining: false`. The checks above pass with overflow on too, because a healthy node never reaches the overflow branch.
4. Run the kill-switch drill once: `media-settings new-episodes --state off --operator <name> --reason <text>`, create an Episode (it binds to Cloudflare with no restart), then `media-settings new-episodes --state on --operator <name> --reason <text>` and create another (own SFU again). Both flags are required, and the command changes nothing without them.

Undo, fastest first:

1. `media-settings new-episodes --state off --operator <name> --reason <text>`. New Episodes go to Cloudflare at once, and live ones finish where they are.
2. Restore the saved lines, with `CHALK_DEFAULT_MEDIA_PLANE=cf_sfu`, and deploy. Do this before any binary rollback: the previous release refuses `chalk_sfu` as the default, so a rollback with the new settings in place leaves the API unable to start.
3. Only then roll the binary back.

**Known risk: one node.** Each environment has one own-SFU node until the spare exists. With overflow off, a full or down node refuses new Episodes with a retryable `503 media.unavailable` (the web client says "Calls are unavailable right now. Try again in a few minutes."), and a live Episode on a lost node recovers to another own-SFU node only if one has room. Until the spare is in place, the kill switch is the only way to keep new calls working through a node outage, so someone must be able to flip it.

## How a changed value reaches the running API

The private API environment lives in AWS SSM. The deploy controller re-fetches it at every deploy and writes the file the API container loads. The API reads that file only at start, so a change reaches it in one of two ways: a deploy, or a host edit plus a restart. The next deploy overwrites the host file from SSM, so both must hold the same value. Never print the file: change one line and print only a count, and save the old line privately first so the undo can tell "absent" from "empty". To undo, restore that line in SSM and on the host, restart the API, and confirm `/readyz` is healthy.

Apply the allowlist to the running API by host edit and restart before dispatching Promote. Promote's first job runs against the release still in production, and that release lets the public API move a Space to `chalk_sfu` only when the running API already lists it. The deploy's own re-fetch comes after that check.

Add the capture flag only if the staging `call-artifacts` proof passed with the same flags. Otherwise dispatch Promote with `capture_proofs=false` and add the flag in a second deploy. With capture on and the recorder fleet missing, the API refuses to start. The deploy controller then rolls back and Promote restores the Pages deployment, media pins and npm tags. The environment file rollback is not proved, so remove the faulty line in SSM too.

## Recording beside the node

Recording starts fast when a capture worker runs on the SFU node, and the on-demand fleet stays as the fallback. The design and its limits are in `docs/recording-transcription.md`. The node's CPU and memory per recorded Episode, the effect on the call and the number of concurrent recordings a node holds are measured in the pull request that added it; read those before changing the worker's limits in `features/media/sfu/deploy/deploy`.

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

The node accepts offers up to 256 KiB (`maxSDPBytes`) and its request limit defaults to 384 KiB (`SFU_MAX_REQUEST_BYTES`; a node that sets it must stay at or above 384 KiB). Older SDKs keep offers under 64 KiB, so they work against either node. An SDK that lets an offer pass 64 KiB gets a 400 from a node with the old cap. So:

- The node ships first. `deploy-web` needs `deploy-managed` in CI, so a web cut cannot go out before the node. Do not publish a web-only cut by another path.
- Publish such an SDK to npm and cut mobile builds only after Promote's proof is green.
- Never roll a node back to the 64 KiB build while a web or SDK release that raises the limit is live. Roll back the web and the node together.

## Undo

The primary undo returns new Episodes to Cloudflare and keeps the release. It needs no image redeploy and no restart.

1. Run `media-settings new-episodes --state off --operator <name> --reason <text>` (the kill switch). It takes effect on the next new Episode, live Episodes finish where they are, and the database keeps an audit row of who flipped it and why. Turn it back on with `--state on`.
2. To leave the own SFU for good, restore the saved lines (`CHALK_DEFAULT_MEDIA_PLANE=cf_sfu`, the old allowlist, `CHALK_SFU_CLOUDFLARE_OVERFLOW` as it was) and restart once. A Space that stored `chalk_sfu` itself needs `media-settings set --plane cf_sfu`. Remove the capture flag only after no Space records on the own SFU.
3. Revert the Promote PR if its change is at fault.

A runtime-only Release re-fetches the environment but keeps the new images, so it does not undo a deploy. A failed Promote rolls itself back. Rolling back after a successful Promote means dispatching the CI workflow from master with the identity of the release before it (see `.github/workflows/ci.yml` inputs and the saved `promotion-rollback` artifact of the Promote run). That path has not been run, so prefer the primary undo.
