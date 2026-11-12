# Moving production to the own SFU

Judgment for running production on the own SFU, and for undoing it. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git. Watch signals and alerts are in the [SFU runbook](../../infrastructure/observability/production-alerts/sfu-runbook.md).

## Production plane

Production runs on the own SFU as the only plane for new Episodes. Cloudflare is off the production path: a new Episode that no node can take is refused with a retryable `503 media.unavailable` instead of starting on Cloudflare (`CHALK_SFU_CLOUDFLARE_OVERFLOW=false`), and a live Episode never moves to Cloudflare. The Cloudflare adapter stays in the code behind the media plane port, and its one production use is the undo: the database kill switch that sends new Episodes back to it. A second own-SFU node as a spare (the 6 USD tier) is planned, so new Episodes have room while one node is down or full.

The production switch is one deploy that sets these lines, then one restart:

1. `CHALK_DEFAULT_MEDIA_PLANE=chalk_sfu` makes the own SFU the plane of every Space and Tenant that stores no plane of its own, and `CHALK_SFU_ALLOWED_SPACES=*` lets every Space use it. A Space that stores `cf_sfu` stays on Cloudflare until `media-settings set --plane chalk_sfu` or `inherit` moves it.
2. `CHALK_SFU_ENABLED=true` and `CHALK_SFU_CAPTURE_ENABLED=true`. The API refuses to start with the own SFU as the default and capture off, because recording and transcription of an own-SFU Episode need capture, and a Space can turn them on at any time.
3. `CHALK_SFU_CLOUDFLARE_OVERFLOW=false`.
4. The Cloudflare application settings (`CHALK_CLOUDFLARE_REALTIME_APP_ID` and `CHALK_CLOUDFLARE_REALTIME_APP_SECRET`) stay, because the kill switch target and Episodes already bound to Cloudflare need them.
5. The transcription dispatcher has `CODESWITCH_PROVIDER=mai` and its OpenRouter token, because without them an Auto-language job fails as retryable and the transcript never arrives.

Start only when `/readyz` shows zero sessions, allocations and cleanup debt, so no real class is live. Then read `/healthz`, and `media-settings get --tenant <tenant> --space <space>` on a throwaway Space: it must report `chalk_sfu`. Run the own-SFU proofs and the kill-switch drill alone on the node.

The web SDK declares `chalk_sfu` since 5.5.0, and the mobile app since the build tagged `mobile-v3.0.6-b40`. A client that declares nothing still gets a Cloudflare call while the Cloudflare application is configured, and that is the one Cloudflare use besides the undo. `CHALK_SFU_CLIENT_SUNSET` turns it into 409 `media.client_unsupported` after the date, so set it once the old builds are gone.

Write each change's undo before making it. Tenant IDs, Space IDs, node addresses and variable values stay in private operator notes, never in Git.

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

The primary undo returns new Episodes to Cloudflare and keeps the release. It needs no image redeploy and no restart.

1. Run `media-settings new-episodes --state off --operator <name> --reason <text>` (the kill switch). It takes effect on the next new Episode, live Episodes finish where they are, and the database keeps an audit row of who flipped it and why. Turn it back on with `--state on`.
2. To leave the own SFU for good, restore the saved lines (`CHALK_DEFAULT_MEDIA_PLANE=cf_sfu`, the old allowlist, `CHALK_SFU_CLOUDFLARE_OVERFLOW` as it was) and restart once. A Space that stored `chalk_sfu` itself needs `media-settings set --plane cf_sfu`. Remove the capture flag only after no Space records on the own SFU.
3. Revert the Promote PR if its change is at fault.

A runtime-only Release re-fetches the environment but keeps the new images, so it does not undo a deploy. A failed Promote rolls itself back. Rolling back after a successful Promote means dispatching the CI workflow from master with the identity of the release before it (see `.github/workflows/ci.yml` inputs and the saved `promotion-rollback` artifact of the Promote run). That path has not been run, so prefer the primary undo.
