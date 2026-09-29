# Lane F: fix "re-enabled camera never reaches other Participants"

Work only in the git worktree /Users/macmini/code/chalk/.worktrees/fix-media-reenable-20260927 (branch fix/media-reenable-20260927, based on origin/master). Run `pnpm install --frozen-lockfile` there first. Commit your work on that branch with clear messages ending in the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Do not push, open PRs, or touch the main checkout at /Users/macmini/code/chalk except to read the evidence listed below.

## The bug (confirmed)

When Participant A turns the camera (or microphone) off and on again, Participant B never receives A's media again. Evidence: /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-b2/repro-exchanges.json and lane-b/repro-remote-video.mjs.

1. Disable: Sync's live target (`apps/sync/lib/chalk_sync/live/episode.ex` apply_live_target, enabled false) calls `revoke_publication` through the provider bridge; the Go API (`apps/api/internal/providerbridge/sfu_executor.go`) force-closes A's track at Cloudflare SFU by MID (`adapters/cloudflare/sfu/adapter.go` CloseTracks, force: true). The SDK then only calls `replaceTrack(null)` (`sdks/typescript/client/src/media/client.ts` #disablePreparedTrack).
2. Enable: the SDK reuses the same transceiver and MID and publishes a new track name via `tracks/new`. Cloudflare returns 200.
3. B pulls the new track: Cloudflare waits ~8s and returns per-track `empty_track_error` ("No track data from remote peer..."). The SDK pulls with `allowPartialRemoteTracks: true`, silently gets zero matched tracks, and retries every poll forever.

History you must respect: before commit a0e7142a (2026-07-24) the SDK used a fresh transceiver per re-enable; that exhausted Cloudflare's per-connection media-section budget (HTTP 410 after several toggles). So neither "fresh MID per toggle" nor "reuse a force-closed MID" works against Cloudflare SFU.

## The fix (agreed design)

Self-disable and forced mute must stop closing the publisher's track at Cloudflare SFU.

- Self-disable pauses sending in the browser only (`replaceTrack(null)` plus `track.enabled = false`), keeps the transceiver, the MID, the Cloudflare track, and its publication identity. Re-enable resumes sending on the same track with `replaceTrack(track)` and no Cloudflare call when the publication is still live. Chalk's authoritative media state (Sync projection / API publication state) still records enabled or disabled, so other Participants' UI hides and shows the tile correctly. Subscribers keep their pulled track and see media again when packets resume.
- Forced mute (`mute_participant`, which today revokes the publication through the external operation consumer) must also not close the Cloudflare track. Enforce it in Chalk: the publication is marked not published so it is not listed for subscribers, and subscribers drop it; when the Participant later re-enables with a valid grant, the same Cloudflare track is listed again. A misbehaving client that keeps sending costs nothing (Cloudflare ingress is free) and nobody pulls it.
- Keep real closes where the track must end: leaving the Episode, removal, Episode end, screen share stop if its model needs it (check), connection replacement.
- Stop hiding per-track provider errors on remote pull: surface them in diagnostics/errors with the provider code, and do not spin a tight retry loop on `empty_track_error`.

First verify the load-bearing assumption before building everything: on the local stack, with the Cloudflare track left open, `replaceTrack(null)` followed later by `replaceTrack(track)` resumes media for an existing subscriber (inbound bytes and decoded frames increase on B). If it does not, stop and write the report explaining what happened.

Read the existing tests (for example "reuses one transceiver and MID across repeated disable and enable cycles" in `sdks/typescript/client/src/media/cloudflare-sfu.test.ts`) and update them to the new behavior; add regressions for repeated self off/on, forced mute then re-enable, and the pull per-track error. Use GLOSSARY.md vocabulary ("Cloudflare SFU", Participant, Episode). Update CHANGELOG.md in the repository's style.

## Verification

1. Gates in the worktree: `pnpm run gate`, `apps/api/scripts/gate.sh`, `apps/sync/scripts/gate.sh`. Report exact results.
2. Live check on the local stack from the worktree: `CHALK_DEV_API_PORT=28080 CHALK_DEV_OBSERVABILITY=disabled pnpm dev`. Another lane (PID 49017) may be using the same local stack ports from the main checkout: wait until `kill -0 49017` fails before starting yours. Run the repro (copy lane-b/repro-remote-video.mjs into your lane folder and adapt it): at least 10 camera off/on cycles and 10 microphone off/on cycles, plus a forced mute then re-enable if the web UI exposes it (otherwise through the SDK). Pass means B shows A's media again within 2s of every re-enable, with screenshots as one contact sheet (ImageMagick `montage ... -geometry 1000x+16+16`).
3. Leave the local stack running at the end so the owner can check by hand, and write the web URL and steps to try in your report.

## Done

Write /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-f-report.md last: what changed (file list and why), commits, gate results, live check results with the contact sheet path, anything that failed or remains, and the manual check steps.
