# Moving production to the own SFU

Judgment for moving a Space from `cf_sfu` to `chalk_sfu` on production, and for undoing it. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git. Watch signals and alerts are in the [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md).

## Order

1. One production deploy (Promote) carries the allowlist (`CHALK_SFU_ALLOWED_SPACES`) and the capture flag (`CHALK_SFU_CAPTURE_ENABLED`).
2. A timed window on Q9-owned proof Spaces only: the watch, the kill-switch drill, then the scripted proofs. No two Episodes ever share a proof Space, and the drill runs alone on the node.
3. When the window is green, move real Spaces one at a time with `media-settings`, then change `CHALK_NEW_SPACE_MEDIA_PLANE`.

Write each step's undo before the step. Start the next step only when the one before is clean. Start only when `/readyz` shows zero sessions, allocations and cleanup debt, so no real class is live.

## The own SFU as the platform default

This step is not applied by this document. `CHALK_DEFAULT_MEDIA_PLANE=chalk_sfu` makes the own SFU the plane of every Space and Tenant that stores no plane of its own. A Space that stores `cf_sfu` stays on Cloudflare.

1. Keep `CHALK_SFU_ENABLED=true` and the Cloudflare application settings (`CHALK_CLOUDFLARE_REALTIME_APP_ID` and `CHALK_CLOUDFLARE_REALTIME_APP_SECRET`): Cloudflare is the fallback and the kill-switch target.
2. Save the previous lines, set `CHALK_DEFAULT_MEDIA_PLANE=chalk_sfu` and `CHALK_SFU_ALLOWED_SPACES=*`, and restart once. Leave `CHALK_SFU_CLIENT_SUNSET` unset, so old SDKs keep working on Cloudflare.
3. Read `/healthz`, then `media-settings get --tenant <tenant> --space <space>` on a throwaway Space: it must report `chalk_sfu`.

The web SDK declares `chalk_sfu` since 5.5.0, and the mobile app since the build tagged `mobile-v3.0.6-b40`. A client that declares nothing gets a working Cloudflare call while a Cloudflare application is configured. Setting `CHALK_SFU_CLIENT_SUNSET` turns that fallback into 409 `media.client_unsupported` after the date, so leave it unset until the old builds are gone.

**Undo.** Restore the saved lines (`CHALK_DEFAULT_MEDIA_PLANE=cf_sfu` and the old allowlist) and restart. Or, with no restart, run `media-settings new-episodes --state off --operator <name> --reason <text>`: every new Episode starts on Cloudflare and live Episodes finish where they are. Spaces that stored `chalk_sfu` themselves need `media-settings set --plane cf_sfu` to leave for good.

## How a changed value reaches the running API

The private API environment lives in AWS SSM. The deploy controller re-fetches it at every deploy and writes the file the API container loads. The API reads that file only at start, so a change reaches it in one of two ways: a deploy, or a host edit plus a restart. The next deploy overwrites the host file from SSM, so both must hold the same value. Never print the file: change one line and print only a count, and save the old line privately first so the undo can tell "absent" from "empty". To undo, restore that line in SSM and on the host, restart the API, and confirm `/readyz` is healthy.

Apply the allowlist to the running API by host edit and restart before dispatching Promote. Promote's first job runs against the release still in production, and that release lets the public API move a Space to `chalk_sfu` only when the running API already lists it. The deploy's own re-fetch comes after that check.

Add the capture flag only if the staging `call-artifacts` proof passed with the same flags. Otherwise dispatch Promote with `capture_proofs=false` and add the flag in a second deploy. With capture on and the recorder fleet missing, the API refuses to start. The deploy controller then rolls back and Promote restores the Pages deployment, media pins and npm tags. The environment file rollback is not proved, so remove the faulty line in SSM too.

## The node ships before any SDK that raises the offer size

The node accepts offers up to 256 KiB (`maxSDPBytes`) and its request limit defaults to 384 KiB (`SFU_MAX_REQUEST_BYTES`; a node that sets it must stay at or above 384 KiB). Older SDKs keep offers under 64 KiB, so they work against either node. An SDK that lets an offer pass 64 KiB gets a 400 from a node with the old cap. So:

- The node ships first. `deploy-web` needs `deploy-managed` in CI, so a web cut cannot go out before the node. Do not publish a web-only cut by another path.
- Publish such an SDK to npm and cut mobile builds only after Promote's proof is green.
- Never roll a node back to the 64 KiB build while a web or SDK release that raises the limit is live. Roll back the web and the node together.

## Undo

The primary undo returns the traffic and keeps the release. It needs no image redeploy and works before and after the window.

1. Put each moved Space back with `media-settings set --plane cf_sfu` (not `inherit`). Only new Episodes move: end a live Episode to move that call. If more than one Space is affected, run `media-settings new-episodes --state off --operator <name> --reason <text>` first (the kill switch). It takes effect on the next new Episode with no API reload, and the database keeps an audit row of who flipped it and why.
2. Remove the capture flag and the proof Space IDs from the allowlist, in SSM and on the host, with one restart.
3. Revert the Promote PR if its change is at fault.

A runtime-only Release re-fetches the environment but keeps the new images, so it does not undo a deploy. A failed Promote rolls itself back. Rolling back after a successful Promote means dispatching the CI workflow from master with the identity of the release before it (see `.github/workflows/ci.yml` inputs and the saved `promotion-rollback` artifact of the Promote run). That path has not been run, so prefer the primary undo.
