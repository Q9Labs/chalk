# Sync hardening session log — 2026-09-27

## Scope agreed

- Focus: Sync correctness, durability, and speed, plus slow media toggles (over 1s in the production web app, user in Karachi; production is AWS us-east-1). Web first. Big-picture fixes, not one-offs. Measure before fixing.
- The owner considers the existing reliability and perf tools stale and not robust; treat them as input, not proof.
- Explain along the way: the owner has been out of the loop for months.

## Lanes launched

- Lane A (gpt-6-luna xhigh priority, PID 46763): toggle path map, Sync correctness design, tool audit. Prompt and report under `scratchpad/sync-hardening-2026-09-27/`.
- Lane B (gpt-6-sol high standard, PID 46764): per-stage toggle latency against the local stack (local Sync/Postgres, real Cloudflare dev app). Production measurement deferred until the transcript canary finishes using production.

## Lane A done; Lane B restarted

- Lane A mapped the toggle path (report: `sync-hardening-2026-09-27/lane-a-report.md`). Verified myself: other Participants learn about a new publication via browser polling every 1s (`media/client.ts:84`) and a Sync reconcile every 2s (`coordinator.ex:24`), not a push. Enable does two Postgres transactions (both synchronous_commit=on) plus Sync→API bridge calls, then the browser does its own API→Cloudflare publish, all serial before the UI shows "on". The SDK phase names `sync_commit`/`sfu_publication` are recorded back-to-back after the same promise, so they don't split the time.
- Lane A ran no harness profiles (my resource-naming constraint blocked shared Postgres helpers; `release-topology-failure-schedule` also fails on a `mint` lock mismatch). Tool audit is from reading code only.
- Lane B's first attempt measured nothing: the main checkout had no node_modules. Ran `pnpm install --frozen-lockfile` and resumed it (PID 62492).

## User-reported symptoms match code

- User has seen the toggle stuck busy and been unable to change their own media state. Verified a mechanism: each source runs behind a one-at-a-time lock (`media-controller.ts:47`, `#serialize` at :370), and SDP work shares one chain across all sources (`media/client.ts` `#serializeSDP`). The signaling `fetch` in `media/transport.ts` has no timeout, and the 15s live-target deadline is cleared before local media work starts. So one hung request can block every later toggle, possibly for all sources, until reload. Not reproduced yet.

## Lane B local results (camera only, 22 enable + 22 disable; mic not reached)

- Local stack, so no Karachi→Virginia distance for Sync/API/Postgres. Still slow: camera disable press→both UIs p50 920ms, p95 2.6s, max 8.6s; camera enable press→A UI p50 598ms, p95 4.2s, max 23s. B's Sync frame after an enable: p50 2.1s, p95 6.1s.
- B never showed A's video or received inbound RTP in 22/22 enables within 3s. Real bug or harness predicate: unverified.
- Local API logs (aggregate, not per toggle): SFU track calls p50 1.67s, p95 9.5s, 9/154 HTTP 503; Cloudflare `create_connection` timed out at 10s twice, breaking joins.
- My check: Cloudflare edge is KHI; a trivial request to rtc.live.cloudflare.com takes 230–435ms. Production api.chalkmeet.com/healthz takes ~340ms (edge in Karachi, tunnel to us-east-1).
- Working hypothesis: Cloudflare Realtime API calls sit in the click path and are slow and flaky from here; the design also polls where it could push.

## Confirmed bug: re-enabled camera never reaches the other Participant (local)

- Repro script `sync-hardening-2026-09-27/lane-b/repro-remote-video.mjs`, screenshots in `lane-b/repro/`. After join, B sees A's video. After A turns the camera off and on, B shows A's avatar and receives no new video bytes for 40s+, in 3/3 cycles. A's own UI shows the camera on.
- API log per cycle: disable's provider operation (~200ms), enable's provider operation (~15ms), A's publish POST tracks (~230ms). Then B's subscribe POST tracks: three calls at ~8.2s each, then roughly one call every 1.2s at ~180ms, all HTTP 200, and no renegotiate ever follows. So B retries forever and never attaches.
- Hypothesis (unverified): disable closes A's track at Cloudflare; re-enable reuses the same sender/transceiver, so B's pull targets a track Cloudflare treats as closed. The API returns 200 while the per-track result inside the body is probably an error. Next step: log the Cloudflare per-track response bodies.
- Local stack stopped.
- Blocker: `pnpm dev:stop` failed its ownership check; after SIGTERM the supervisor (PID 61979) hangs in "stopping" because every `docker` command (OrbStack) hangs. App ports are released. Did not restart OrbStack because other agents may depend on it.

## Decisions and new lanes

- OrbStack restarted (user approved). User approved lanes and said not to ask about launching lanes again.
- User asked about cost of keeping tracks open vs rebuilding, and whether Cloudflare is consistently slow; open to other SFUs or self-hosting (Pakistan, UAE, Oman, Saudi; maybe Singapore or several regions).
- Cloudflare Realtime bills only egress ($0.05/GB after 1,000 GB/month free, shared with TURN); ingress, API calls, sessions, and tracks are free (developers.cloudflare.com/realtime/sfu/pricing).
- Launched: B2 (Sol high, resumed session, PID 49017) re-enable bug evidence + per-toggle server timing; C (Luna xhigh, 49019) run Sync correctness suites; D (Luna max, 49020) direct Cloudflare Realtime latency probe from Karachi; E (Sol high, 49023) SFU alternatives research. Prompts in `sync-hardening-2026-09-27/lane-*-prompt.md` + `common.md`.

## Re-enable bug root cause and fix lane

- Cloudflare evidence (lane-b2/repro-exchanges.json): disable force-closes A's track by MID; re-enable publishes a new track name on the same MID (200); B's pull waits ~8s and gets per-track `empty_track_error`. SDK pulls with allowPartialRemoteTracks and silently retries forever.
- History: commit a0e7142a (2026-07-24) switched to MID reuse because fresh MIDs exhausted Cloudflare's per-connection media-section budget (HTTP 410). Both approaches fail, so the fix is design-level: self-disable and forced mute stop closing the Cloudflare track; Chalk state decides visibility.
- Added "Cloudflare SFU" vendor-terms entry to GLOSSARY.md in the main checkout (uncommitted; language ratchet passes).
- Lane F (Sol high, PID 50898) implements the fix in `.worktrees/fix-media-reenable-20260927`, verifies the resume assumption first, leaves the local stack running for the owner's manual check.

## Lanes C, D, E, B2 reported

- C: all Sync suites pass after `mix deps.get` and building diagnostics-contracts (gate 79 tests, correctness 6/6, breaker 36 schedules, topology 3/3 incl. failover). Gaps: node kill right after ACK, slow consumer, original primary restore. Doc says 37 breaker schedules, code has 36. Production Sync DB is single-node PlanetScale by owner's Sept 5 cost decision, so failover coverage doesn't match prod.
- D: direct Cloudflare SFU probe from Karachi, 1,100 calls / 100 cycles over 31 min: 254ms p50, 784 p95, 1,084 p99, zero errors; close→republish→pull worked 100/100 when done with a negotiated close and a fresh transceiver (one republish per connection, so the media-section budget was never hit). Initial join to first decoded frame 4.4s p50 / 7.2s p95. Conclusion: Cloudflare SFU is not consistently slow; Chalk's 1.7s/9.5s stats were inflated by the 8s empty_track pulls and Chalk's own sequencing.
- B2: Sync command RTT locally is fast (mic enable 31ms median). The big gap is A's Sync reply → B's matching frame, 1.5–1.7s median: the reconcile/polling path. Confirms push-not-poll as the main Sync speed item.
- E: if ever switching, trial LiveKit Cloud (Mumbai, UAE, Saudi) and LiveKit OSS in UAE. List-price media for 1k/10k Participant-hours: Cloudflare $56/$1,006, LiveKit Cloud ~$273/~$2,311. RTT matrix unmeasured.
- My call: no case for switching SFU today; fix Chalk's side first.
