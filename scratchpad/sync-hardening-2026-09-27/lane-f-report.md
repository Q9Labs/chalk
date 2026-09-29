# Lane F — media re-enable report

## Result

Fixed camera and microphone re-enable without opening a new Cloudflare SFU media section or reusing a force-closed MID. Self-disable now pauses the browser sender while retaining its Cloudflare SFU publication and subscriber track. Forced mute removes the publication from Chalk subscriber availability without closing the provider track; an authorized re-enable restores the same publication identity. Real termination paths still close tracks.

The load-bearing local proof ran before implementation: with A's Cloudflare SFU track left open, `replaceTrack(null)` then `replaceTrack(track)` increased B's existing inbound video from 22,739 bytes / 5 decoded frames to 25,409 bytes / 6 frames in 104 ms. Evidence: [open-track-proof.json](lane-f/open-track-proof.json).

## Changed files and why

- `apps/api/internal/adapters/cloudflare/sfu/adapter.go`, `adapter_observation_test.go`; `apps/api/internal/providerbridge/sfu_executor.go`, `sfu_executor_test.go`: distinguish retained publication unavailability from real Cloudflare SFU track close, with regression coverage.
- `apps/api/internal/mediapublications/service.go`, `availability_test.go`; `apps/api/internal/mediaplane/signaling.go`; `apps/api/internal/provideroperations/types.go`, `types_test.go`: keep Chalk's authoritative enabled/published state and listing correct across self pause, forced mute, and grant-based re-enable. `apps/api/internal/adapters/postgres/recording_capture_plans.go`, `recording_capture_plans_test.go`, and `apps/api/internal/traceharness/scenario_launch_p0.go` preserve termination/recording behavior.
- `apps/api/db/migrations/20260927160000_sync_media_pauses.sql`, `apps/api/db/migrations/embed.go`; `apps/sync/lib/chalk_sync/stateholder.ex`, `stateholder/memory.ex`, `stateholder/postgres.ex`, `stateholder/postgres/media_pauses.ex`, `stateholder/postgres/sql/media_pauses.ex`: persist bounded self-pause state in Postgres so a disposable Sync coordinator cannot incorrectly republish paused media after recovery. `apps/sync/lib/chalk_sync/retention/cleanup_worker.ex`, `retention/sql.ex`, `apps/sync/test/support/sync_postgres.ex` handle lifecycle cleanup.
- `apps/sync/lib/chalk_sync/live/episode.ex`, `live/projection.ex`, `provider_bridge/codec.ex`; `apps/sync/test/chalk_sync/live/media_publication_identity_test.exs`, `self_pause_projection_test.exs`, `stateholder/postgres_media_pauses_test.exs`: project paused media as inactive while retaining its publication identity, reload durable pauses, and cover restart/re-enable behavior.
- `sdks/typescript/client/src/media/client.ts`, `plane.ts`, `types.ts`, `cloudflare-sfu.test.ts`; `sdks/typescript/client/src/sync/v1-client.ts`, `v1-client.test.ts`: reuse one sender/transceiver/MID and publication across repeated self toggles, surface per-track Cloudflare SFU pull errors with provider codes, back off `empty_track_error`, and immediately rediscover a resumed same-ID remote publication. Forced-mute/re-enable and repeated-toggle regressions are included.
- `sdks/typescript/react/src/selectors/space-selectors.ts`, `space-selectors.test.ts`: obey projected camera visibility while the underlying subscriber track remains attached.
- `contract/schema/sync-v1.json`, `contract/generated/openapi.json`, `apps/api/docs/generated-canonical-openapi.js`, `apps/sync/lib/chalk_sync/contract/generated.ex`, `sdks/typescript/client/src/generated/openapi-types.d.ts`, `schemas.ts`, `sync.ts`, `tools/contract-fixture-proof/src/emitters/sync-elixir.mjs`, `sync-typescript.mjs`: permit a disabled projected publication to retain its ID and keep generated contracts synchronized.
- `CHANGELOG.md`: document the new behavior in repository style.

## Commits

- `e280bd582b476bfc7f1b830bcfcfeb396e2174a8` — `fix: retain Cloudflare media publications across pause and mute`
- `966d3850f75963c38d828d5da4e37d507f9e1c84` — `fix: persist media pauses and expedite retained-track recovery`

Both commits end with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`. Branch: `fix/media-reenable-20260927`. Worktree clean. Nothing pushed; no PR opened.

## Verification

Final-source M4 test mirror of this worktree, using the exact required commands:

| Gate                                                               | Result                                                                     |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `pnpm run gate`                                                    | Exit 0 — Smart gate passed                                                 |
| `apps/api/scripts/gate.sh`                                         | Exit 0 — Go API gate passed                                                |
| `apps/sync/scripts/gate.sh` (via `scripts/gates/with-postgres.sh`) | Exit 0 — Sync server gate passed; 82 tests passed, 2 configured exclusions |

The local worktree dev stack was started with `CHALK_DEV_API_PORT=28080 CHALK_DEV_OBSERVABILITY=disabled pnpm dev` after the other lane's stack cleared. Web, API, and Sync readiness currently return HTTP 200. The stack remains running for manual inspection.

Final combined two-Participant browser check: **10/10 camera off/on cycles passed** (B recovered in 271–721 ms), **10/10 microphone off/on cycles passed** (236–840 ms), and forced mute made B drop A's audio in 2 ms, then A's authorized SDK re-enable restored B's audio in 1,129 ms. Each recovery was under the required 2 seconds; B's inbound bytes and decoded video frames advanced. Full run: [live-check-output.log](lane-f/live-check-output.log) and [repro/log.json](lane-f/repro/log.json). A/B screenshots were reviewed together in [contact-sheet.png](lane-f/contact-sheet.png). Repro: [repro-remote-video.mjs](lane-f/repro-remote-video.mjs).

## Failures or remaining limitations

Earlier exploratory runs occasionally exceeded the 2-second forced-reenable deadline. The review found that an SDK cooldown could survive a same-ID resume and that Sync self-pauses lived only in a disposable coordinator; both were fixed, followed by the passing final combined run and all three green gates. The web Participants menu did not expose a Mute action in this local scenario, so the forced-mute check used the SDK with a local moderator capability fixture. No known failing gate or uncommitted code remains.

## Manual check

Open **http://127.0.0.1:3070**. Create a Space, join the same Episode as Participant A and Participant B in separate browser profiles/tabs, enable camera and microphone for A, and toggle each off and on repeatedly. On B, A's tile/audio should hide while disabled and return promptly after re-enable. For the forced-mute path, the local SDK repro can be rerun from this worktree with `LANE_F_FORCE_SDK=1 node /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-f/repro-remote-video.mjs`; it creates its own test Space, invokes B's authorized SDK mute, and checks B's drop and recovery.
