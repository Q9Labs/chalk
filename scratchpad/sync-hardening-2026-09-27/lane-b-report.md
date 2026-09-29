# Lane B — local media-toggle timing report

## Outcome

The harness and local two-Participant measurement ran against the development stack and its configured real Cloudflare Realtime SFU. The requested full sample was **not completed**: the first run recorded 22 successful camera enables and 22 successful camera disables (with two additional unsuccessful disable attempts), then the local app presented a connection-status dialog. A fresh Space could not be joined because the local API timed out while creating a Cloudflare SFU connection. Microphone toggles were not measured. Do not treat the results below as a 30-per-direction benchmark or as evidence about production topology.

The original dependency-blocked report was moved to `scratchpad/sync-hardening-2026-09-27/lane-b/report-attempt1-no-deps.md`, as requested. Raw toggle records are in `scratchpad/sync-hardening-2026-09-27/lane-b/attempt1-toggles.json` and `attempt2-toggles.json`; `toggles.json` is also the incrementally written first-run file. No invite capability or credential was saved in those files.

## What was measured and how to rerun

I started the local stack with the real development Cloudflare credentials resolved through 1Password; startup’s SFU probe succeeded. Port 8080 was already occupied by a pre-existing SSH forward, so the API used 28080. I disabled the optional observability profile to avoid unrelated compose startup work. The stack was ready at local web `127.0.0.1:3070`, API `127.0.0.1:28080`, and Sync `127.0.0.1:4100`.

The runner creates a local public Space and keeps its invite link only in memory, launches two isolated headless Chromium contexts with `--use-fake-ui-for-media-stream` and `--use-fake-device-for-media-stream`, and joins Participants “Lane B A” and “Lane B B” to that Space. It toggles the UI controls, alternating requested media-source state with a 300 ms pause. The page init script records wall-clock timestamps (performance time origin plus monotonic elapsed time) for the button event, relevant `getUserMedia` calls, wrapped WebSocket command/reply/projection frames, A and B UI state, RTCPeerConnection state/description events, `replaceTrack` spans, and B’s inbound RTP byte increases polled through `getStats`. Enable-side inbound RTP was allowed 3 seconds to appear; the UI wait was 30 seconds. The summaries below use transitions where A’s UI showed the requested state; raw JSON also retains failed attempts and missing milestones.

Exact rerun commands from the repository root (with workspace dependencies installed and local 1Password access available):

```sh
CHALK_DEV_API_PORT=28080 CHALK_DEV_OBSERVABILITY=disabled pnpm dev
pnpm dev:status
LANE_B_PAIRS=30 LANE_B_PAUSE_MS=300 LANE_B_RTP_TIMEOUT_MS=3000 node scratchpad/sync-hardening-2026-09-27/lane-b/measure.mjs
pnpm dev:stop
```

The runner defaults to camera then microphone and 30 enable/disable pairs for each source. It uses the installed Playwright module and falls back to the installed Chrome channel if Playwright’s bundled Chromium executable is absent. The measurement script and init instrumentation are in `scratchpad/sync-hardening-2026-09-27/lane-b/measure.mjs` and `instrument.js`.

## Stage latency

All values are milliseconds, shown as **p50 / p95 / max (n)**. Percentiles are nearest-rank. Toggle-stage summaries use successful A-UI transitions only. `—` means no usable sample; “not observed” means a measurement was attempted but its event did not arrive within the stated timeout.

| Measured stage                                                            |                          Camera enable |                         Camera disable | Microphone enable | Microphone disable |
| ------------------------------------------------------------------------- | -------------------------------------: | -------------------------------------: | ----------------: | -----------------: |
| Button press → Sync command frame sent                                    |              67.6 / 174.1 / 261.1 (22) |              76.6 / 201.2 / 254.0 (22) |             — (0) |              — (0) |
| `getUserMedia` start → resolve                                            | — (0; no toggle-time capture observed) | — (0; no toggle-time capture observed) |             — (0) |              — (0) |
| Sync command frame → reply frame                                          |            91.7 / 2496.4 / 3280.6 (22) |           717.3 / 2417.3 / 8356.8 (22) |             — (0) |              — (0) |
| Sync reply → A UI state                                                   |          450.6 / 3758.8 / 22935.6 (22) |              76.8 / 224.2 / 281.9 (22) |             — (0) |              — (0) |
| Button press → A UI state                                                 |          597.8 / 4212.4 / 23247.4 (22) |           805.2 / 2647.8 / 8610.5 (22) |             — (0) |              — (0) |
| Sync reply → B Sync state frame                                           |         1951.2 / 5676.3 / 24785.2 (22) |                    0.4 / 0.5 / 0.5 (3) |             — (0) |              — (0) |
| Button press → B Sync state frame                                         |         2113.8 / 6129.9 / 25097.0 (22) |            488.1 / 1008.5 / 1008.5 (3) |             — (0) |              — (0) |
| Button press → B UI state                                                 |                    not observed (0/22) |            434.5 / 919.6 / 1961.3 (22) |             — (0) |              — (0) |
| A `replaceTrack` sender-change span                                       |                   0.6 / 3.6 / 4.6 (22) |              34.9 / 147.1 / 171.1 (22) |             — (0) |              — (0) |
| A RTCPeerConnection `setLocalDescription` span                            |                4.0 / 17.8 / 245.2 (22) |                    2.8 / 2.8 / 2.8 (1) |             — (0) |              — (0) |
| A RTCPeerConnection `setRemoteDescription` span                           |                   3.4 / 8.2 / 9.9 (22) |                    8.7 / 8.7 / 8.7 (1) |             — (0) |              — (0) |
| Button press → B inbound RTP byte increase                                |         not observed (0/22 within 3 s) |                         not applicable |             — (0) |              — (0) |
| Total: press → both UI states; enable additionally requires inbound media |                    not observed (0/22) |           919.6 / 2647.8 / 8610.5 (22) |             — (0) |              — (0) |

For the first run, camera enable had 22 successful A transitions; all 22 exposed the corresponding B Sync state frame, but none exposed the expected B video UI state or an inbound video-byte increase within 3 seconds. For camera disable, 22 A and B UI transitions were observed; only three matching B Sync state frames were captured by the current frame predicate. Two other camera-disable attempts did not reach A’s requested UI state. The experiment never advanced to microphone toggles.

## Which stage dominates

**Measured fact:** among the complete camera-disable paths, the Sync send-to-reply interval is the largest median component at 717 ms (p95 2417 ms), compared with 77 ms median from reply to A’s UI and 435 ms from press to B’s UI. The press-to-both-UI total is 920 ms median and 2648 ms p95. That observed camera-disable p95 exceeds the stated 100 ms state-signal target, but it is a small, incomplete local sample and is not a microphone result.

**Measured fact:** on camera enable, local sender replacement was short (0.6 ms median, 3.6 ms p95); the recorded `setLocalDescription` and `setRemoteDescription` spans were also much shorter than the B-side delivery milestones. Button-to-B-Sync-frame was 2114 ms median and 6130 ms p95, with a 25097 ms maximum. A’s UI and B’s Sync projection advanced, while B’s video UI and inbound RTP did not appear in any of the 22 enable trials. Therefore a valid enable end-to-end total could not be calculated.

**Inference:** the measured camera path suggests that local sender mutation and peer-description work were not the dominant delay in the observed cases. For disables, the wire-observed Sync round trip dominates the median. For enables, the late B projection plus the absent remote Track/media evidence points beyond the local sender change, toward Sync/SFU coordination or SFU media delivery. The run cannot distinguish those causes: the SDK Promise completion includes local MediaPlane work, the wire frame is not the Promise-resolution time, and the SFU transport failures interrupted the sample. It also cannot answer whether Karachi latency in production is primarily network distance or production topology.

## What the diagnostic phases actually mark

In `media-controller.ts` `#set` (around line 216):

- `local_track_state` is observed after optional capture/preparation and also unconditionally after the capture branch. If a Track is already held (as it was during these toggles), the capture branch is skipped; this phase does not mean a new device capture or a sender-state change just occurred. The phase is observed before the Sync command.
- `sync_commit` is observed after `ports.sync.setMicrophoneEnabled` / `setCameraEnabled` resolves. The v1 live-target coordinator resolves that Promise only after it has received the server result and the local `MediaPlane.setLocalPublicationTarget` operation has succeeded. It is therefore not a server-only Sync commit timestamp.
- `sfu_publication` follows immediately after the active-ports assertion, with no separate awaited publication or remote-delivery operation between it and `sync_commit`. It is a success checkpoint after the broader Promise, not a timestamp proving B received media; the same checkpoint is used for disable/unpublish.

## Server-side evidence and limits

With optional observability disabled, no OTLP trace correlation was available. Local API logs were cheap to collect, but are only a whole-runtime aggregate (including harness setup and failed join attempts), not a per-toggle attribution. They showed:

- 27 public invite-arrival requests: 22 HTTP 201, 4 HTTP 500, 1 HTTP 503; duration p50 1243 ms, p95 10045 ms, max 10151 ms.
- 154 SFU track requests: 145 HTTP 200, 9 HTTP 503; duration p50 1667 ms, p95 9547 ms, max 10426 ms.
- 1181 SFU publication reads: 1177 HTTP 200, 1 HTTP 500, 3 HTTP 503; duration p50 9 ms, p95 1048 ms, max 10790 ms.

The fresh-run join failure was specifically logged as Cloudflare SFU `create_connection`, transport failure, provider code `timeout`, with no HTTP response; the local `POST /v1/public/space-invite-arrivals` then returned HTTP 500 in 10151 ms. A previous invite-arrival request also returned HTTP 500 after a 10036 ms SFU transport timeout. Sync provider-bridge readiness checks remained HTTP 200. These logs establish the local run’s external-SFU failure boundary, not the per-toggle latency distribution. No secrets, invite links, Participant IDs, Space IDs, or raw server log lines are included here.

## Failures and unmeasured items

- Run 1 stopped after 46 camera attempts when a connection-status dialog intercepted the next control. It retained 22 successful camera enables, 22 successful camera disables, and two unsuccessful disable attempts; it did not reach the microphone series.
- Run 2 created a fresh Space but timed out waiting for the first Participant’s joined-state UI. API logs identify the Cloudflare SFU `create_connection` transport timeout described above. It recorded no toggles.
- The target of at least 30 successful enables and 30 successful disables for **each** media source was not met. There are no microphone percentiles and no enable total percentiles.
- Device capture was instrumented during toggles but no `getUserMedia` start/resolve event occurred; the required fake camera/microphone tracks were already held after join. Initial join-time capture is outside the toggle measurements.
- The remote camera UI and inbound RTP were not observed on B for any camera enable. The enable total is consequently missing, not zero.
- Sync service-side per-command timing and correlated OTLP spans were not available. API request aggregates above cannot be attributed to a particular toggle.
- Startup resolved local development Cloudflare credentials successfully; no credential-resolution error occurred.

The local stack was stopped after measurement. `pnpm dev:stop` initially hit an ownership-command mismatch; after verifying the exact live Chalk supervisor and its owned services, its SIGTERM shutdown handler completed. A subsequent `pnpm dev:stop` returned successfully, `pnpm dev:status` reported `stopped`, and `docker ps` showed no Chalk development containers. No tracked repository files were changed.
