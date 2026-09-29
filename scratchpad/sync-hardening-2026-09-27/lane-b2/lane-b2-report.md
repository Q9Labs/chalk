# Lane B2 — local media-toggle timing and re-enable evidence

## Measured facts

This run used one local Space and two Participants per Playwright run, real headless Chromium with fake microphone/camera devices, the local API on `127.0.0.1:28080`, local Sync on `127.0.0.1:4100`, local web on `127.0.0.1:3070`, and the **local development** Cloudflare Realtime app. No production service was contacted. Participant A toggled; Participant B observed. There was a 300 ms pause between toggles. The three timing runs contain 30 successful microphone enables, 30 successful microphone disables, 30 successful camera enables, and 31 successful camera disables. Six additional failed attempts are retained, not silently discarded. The separate camera repro contains three off/on cycles.

Wall-clock timestamps came from an init-script WebSocket wrapper, `getUserMedia` wrapper, `RTCRtpSender.replaceTrack` and `RTCPeerConnection` hooks, DOM state observation, and per-`RTCStatsReport`-ID outbound/inbound RTP byte increases. Browser `media/sfu/*` requests were paired with API `http.request` durations by `x-chalk-journey-id`; Sync→API provider operations were paired by the Sync command's operation ID; Cloudflare durations came from a temporary **Go build overlay** of the API adapter, not a tracked source edit. The overlay recorded only allowlisted request/response fields, redacted SDP, and eight-character Cloudflare session-ID prefixes. Cloudflare calls were joined to API requests by containment/time, endpoint, and A/B Participant; matched calls were then checked against the **new track name for that toggle**. Of 406 captured Cloudflare calls, 356 could be linked to a measurement browser/API request; unmatched setup/repro/background calls were not used as per-toggle stages. Sync logs had **zero per-operation duration entries**, so the browser's Sync v1 frame round trip and the API's provider-operation request duration are the available Sync-side bounds, not a full internal Sync breakdown. OTLP was disabled.

Each cell below is **p50 / p95 / max milliseconds (n)**, nearest-rank percentiles over successful A-UI toggles. `—` means unobserved or inapplicable. Durations for nested calls (API and its Cloudflare call) and end-to-end milestones **overlap and must not be summed**. Enabling had no `getUserMedia` call in any measured toggle: the device tracks were already held after joining. `replaceTrack` and SDP method timings bracket browser calls; they are not the whole renegotiation/publication interval. B inbound media was watched for at least 15 s when B's UI reached the target, and for the 30 s UI observation window when it did not. `never` is distinct from `late` in the raw data; there were **no late successes**.

### Microphone enable — 30 successful attempts

| Stage | p50 / p95 / max ms (n) |
| --- | ---: |
| Press → Sync command frame sent | 44.9 / 137.4 / 177.6 (30) |
| Sync command frame → reply | 30.6 / 335.6 / 518.0 (30) |
| Sync→API provider operation, server | 9.2 / 56.0 / 116.3 (30) |
| A sender `replaceTrack` | 0.1 / 1.0 / 4.4 (30) |
| A `setLocalDescription` / `setRemoteDescription` | 2.4 / 7.5 / 7.7 (30) / 1.5 / 4.7 / 24.5 (30) |
| A `media/sfu/tracks`, browser / API server | 272 / 653 / 712 (30) / 270.8 / 653 / 710.5 (30) |
| Cloudflare local publication | 253.8 / 641.7 / 695.9 (30) |
| Press → A UI | 381.6 / 949.3 / 1116.6 (30) |
| Press → A outbound RTP increase | 133.5 / 484.4 / 711.8 (30) |
| Press → B matching Sync frame | 1778.5 / 1918.1 / 2173.3 (29) |
| B matching Sync frame → B UI | 22.3 / 66.3 / 127.8 (29) |
| Press → B UI | 1813.7 / 1932.9 / 2195.6 (29) |
| B first `media/sfu/tracks`, browser / API server | 8262 / 8445 / 8691 (30) / 8260.5 / 8445.7 / 8688.7 (30) |
| Cloudflare first remote pull | 8247.9 / 8437.8 / 8686.3 (30) |
| Press → B inbound RTP increase / full media total | — (0; **30/30 never** within 15 s) |
| Press → both UIs (state-signal total) | 1813.7 / 1932.9 / 2195.6 (29) |

### Microphone disable — 30 successful attempts, 5 additional failed attempts

| Stage | p50 / p95 / max ms (n) |
| --- | ---: |
| Press → Sync command frame sent | 47.4 / 97.5 / 160.5 (30) |
| Sync command frame → reply | 285 / 667.8 / 3527.3 (30) |
| Sync→API provider operation, server | 273.7 / 650.8 / 3315.8 (30) |
| Cloudflare forced track close | 246.5 / 550.1 / 619.3 (30) |
| A sender `replaceTrack(null)` | 19.6 / 91.1 / 91.7 (30) |
| A SDP methods | — (0; no renegotiation on disable) |
| Press → A UI | 394.1 / 838 / 3849.9 (30) |
| Press → B matching Sync frame | 340.4 / 662.6 / 662.6 (16) |
| B matching Sync frame → B UI | 22.9 / 105.8 / 105.8 (16) |
| Press → B UI | 375.4 / 768.4 / 3788.9 (30) |
| Press → both UIs (state-signal total) | 394.1 / 838 / 3849.9 (30) |

### Camera enable — 30 successful attempts, 1 additional failed attempt

| Stage | p50 / p95 / max ms (n) |
| --- | ---: |
| Press → Sync command frame sent | 84.7 / 251.6 / 265.8 (30) |
| Sync command frame → reply | 136.1 / 1267.4 / 1646.8 (30) |
| Sync→API provider operation, server | 16.3 / 483.9 / 532.4 (30) |
| A sender `replaceTrack` | 0.4 / 2.5 / 4.3 (30) |
| A `setLocalDescription` / `setRemoteDescription` | 4.4 / 11.2 / 11.5 (30) / 2.9 / 5.8 / 13.6 (30) |
| A `media/sfu/tracks`, browser / API server | 262 / 734 / 1030 (30) / 252.2 / 732.6 / 1070.2 (30) |
| Cloudflare local publication | 215.5 / 381.4 / 678.4 (30) |
| Press → A UI | 593.9 / 1902.7 / 2926.5 (30) |
| Press → A outbound RTP increase | 90.7 / 431.5 / 537.5 (30) |
| Press → B matching Sync frame | 1540 / 3740.4 / 3805.8 (28) |
| Press → B video UI | — (0; **30/30 never** within 30 s) |
| B first `media/sfu/tracks`, browser / API server | 8324 / 8735 / 9472 (30) / 8310.2 / 8666.1 / 9440.3 (30) |
| Cloudflare first remote pull | 8297.6 / 8547.4 / 9431.6 (30) |
| Press → B inbound RTP increase / full media total | — (0; **30/30 never** within 30 s) |

### Camera disable — 31 successful attempts

| Stage | p50 / p95 / max ms (n) |
| --- | ---: |
| Press → Sync command frame sent | 110.8 / 323.3 / 356.9 (31) |
| Sync command frame → reply | 439.6 / 2010.5 / 3200.9 (31) |
| Sync→API provider operation, server | 330.7 / 1445.9 / 1629 (31) |
| Cloudflare forced track close | 206.8 / 389.5 / 562 (31) |
| A sender `replaceTrack(null)` | 46.9 / 92.1 / 198.2 (31) |
| A SDP methods | — (0; no renegotiation on disable) |
| Press → A UI (meaningful local total) | 669.4 / 3596.9 / 3671.3 (31) |
| Press → B matching Sync frame | 788.6 / 3453.4 / 3453.4 (3) |
| Press → B UI **off condition observed** | 410.9 / 921.9 / 10575.4 (31) † |
| Press → both UI conditions observed | 804.8 / 3671.3 / 10575.4 (31) † |

† After the first camera disable, B never reacquired A's video, so later B-off UI observations were often an **already-true condition**, not a fresh state transition. These numbers are retained as observation timings but **must not be used as camera-disable propagation latency**. The B Sync-frame matcher found only 16/30 microphone-off and 3/31 camera-off frames; B UI observation is not proof of a matching frame and missing matches are not proof no frame arrived. No browser or Cloudflare local-publish call occurred on disable. The successful provider operation had one API attempt per toggle; the failed microphone-disable attempts had repeated operation-ID retries and are excluded from the percentiles.

## Exact redacted Cloudflare exchange for the camera re-enable bug

The [selected raw exchanges](./repro-exchanges.json) preserve HTTP method/status, duration, request and response bodies, new and old track names, MID, and eight-character session prefixes. The full [allowlisted trace](./cloudflare-calls.ndjson) contains the other calls. SDP is `[redacted]`; headers and secrets were never recorded. The first camera publication was `camera-5b93c1b7-918e-4ca9-b1c7-bff5970cb168` on A's Cloudflare session prefix `bf6a5c7b`, MID `1`. B initially received it: its inbound video stats reached 306,485 bytes / 135 frames before off, then 323,766 bytes / 146 frames after off and did not increase again across three off/on cycles ([repro log](./repro/log.json), [contact sheet](./repro/contact-sheet.png)).

**A disable:** `PUT /sessions/bf6a5c7b/tracks/close`, 252.884 ms, HTTP 200.

```json
request  {"tracks":[{"mid":"1"}],"force":true}
response {"requiresImmediateRenegotiation":false,"tracks":[{"mid":"1"}]}
```

**A re-enable:** `POST /sessions/bf6a5c7b/tracks/new`, 264.277 ms, HTTP 200. It created **new track name** `camera-4f7abaa0-bcea-4abb-91de-7bcd78c810c6`, but **reused the closed MID `1`** on the same Cloudflare session.

```json
request  {"sessionDescription":{"type":"offer","sdp":"[redacted]"},"tracks":[{"location":"local","mid":"1","trackName":"camera-4f7abaa0-bcea-4abb-91de-7bcd78c810c6"}]}
response {"requiresImmediateRenegotiation":false,"sessionDescription":{"type":"answer","sdp":"[redacted]"},"tracks":[{"mid":"1","trackName":"camera-4f7abaa0-bcea-4abb-91de-7bcd78c810c6"}]}
```

**B remote pull:** `POST /sessions/4be1233a/tracks/new`, HTTP 200 for each of three attempts. The request below was repeated; the response below was repeated with `requiresImmediateRenegotiation:false`, no SDP offer, empty MID, and an item-level error. Cloudflare durations were **8279.161, 8743.051, and 8277.534 ms**. The first pull began after A's re-enable publish had returned, so this was not merely B outrunning that HTTP acknowledgement.

```json
request  {"tracks":[{"location":"remote","sessionId":"bf6a5c7b","trackName":"camera-4f7abaa0-bcea-4abb-91de-7bcd78c810c6"}]}
response {"requiresImmediateRenegotiation":false,"tracks":[{"mid":"","sessionId":"bf6a5c7b","trackName":"camera-4f7abaa0-bcea-4abb-91de-7bcd78c810c6","errorCode":"empty_track_error","errorDescription":"No track data from remote peer. Make sure the publisher peer is connected and sending packets for this track"}]}
```

The 30/30 first matched B pulls after microphone re-enable and 30/30 after camera re-enable also returned item-level `empty_track_error`, and their browser-facing Chalk API calls were HTTP 200 in all 60 cases. [Cloudflare documents `empty_track_error`](https://developers.cloudflare.com/realtime/sfu/observability/error-codes/) as a subscription that did not receive source media in time, advising checks of the publisher connection and outgoing packets. Thus the approximately eight-second **Cloudflare call itself**, not local API processing or network distance to the Mac, is the observed wait; attributing its precise internal timer is an inference, not a measurement. The initial B pull before disable succeeded in 498.740 ms, whereas the post-re-enable first pull waited 8279.161 ms.

The per-track error is detected, then effectively hidden from B's application flow here:

1. `apps/api/internal/adapters/cloudflare/sfu/adapter.go:452-459` constructs a track-level provider failure and marks remote partial response; `:522-528` permits the normalized `unknown` code, and `:533-551` omits failed tracks from the returned media-plane track list.
2. `apps/api/internal/httpapi/sfu_signaling.go:160-165,204-208` returns that partial response with a **nil error** when `allow_partial_remote_tracks=true`, yielding HTTP 200. The code does not carry `empty_track_error` to the SDK response.
3. `sdks/typescript/client/src/media/client.ts:505-510` requests partial remote tracks and returns an empty match list; `:529-531` performs no renegotiation when `requiresImmediateRenegotiation` is false. This is where B loses the per-track failure as an actionable signal.

## Dominance and root-cause hypothesis — inferences, not fixes

- **Microphone enable:** B's state-signal/UI milestone is dominated by the roughly **1.7 s gap after A's Sync reply before B's matching frame**, rather than the 31 ms median Sync command RTT, 9 ms API provider operation, or 254 ms Cloudflare local publish. B's first media pull then spends a separate 8.25 s median at Cloudflare and fails; there is no valid full-media total. The browser and Sync reconciliation components of the 1.7 s gap were not individually timed server-side.
- **Microphone disable:** the Sync command waits for the Sync→API provider operation (274 ms median), most of which is Cloudflare forced close (247 ms median). This is the largest identified nested server stage in the 394 ms median state-signal total, and the 3.32 s API-provider outlier largely explains the 3.85 s maximum.
- **Camera enable:** A's UI completes in 594 ms median, but B's matching Sync frame takes 1.54 s median and its video UI/media never returns. The dominant observed failed-media stage is Cloudflare's first remote pull, **8.30 s median**, not the 216 ms median local publication. The camera state-signal/full-media total is **right-censored**, not a successful latency percentile.
- **Camera disable:** A's meaningful local total is 669 ms median. The Sync command RTT (440 ms median; 2.01 s p95) and nested provider operation (331 ms median; 1.45 s p95), including the Cloudflare close (207 ms median), dominate identified work. B-off UI/combined timings are not causal after B has lost video.

**Hypothesis:** `force:true` closes the publication at the SFU without renegotiation, while A later `replaceTrack`s onto the **same transceiver/MID** and publishes a fresh track name (`sdks/typescript/client/src/media/client.ts:290-305,349-369`). The resumed browser sender reports outbound bytes, but Cloudflare's new publication is not receiving usable source media for B; B's pull times out as `empty_track_error`. [Cloudflare's connection-pattern guidance](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/) distinguishes forced close without an offer from negotiated media close, and its [negotiation guidance](https://developers.cloudflare.com/realtime/sfu/concepts/negotiation/) cautions that HTTP 200 does not establish per-item success. **Supporting evidence:** the exact same MID/Cloudflare session is reused with a new name; A's outbound RTP bytes increased in 30/30 successful re-enables of each kind; B's inbound RTP never increased; B's pulls all produced the same per-track error. **Evidence against certainty:** Cloudflare accepted A's new publication with HTTP 200 and an SDP answer, and A's browser reports outbound bytes, so a lost/invalid SFU MID mapping is not proven. There was no packet capture at Cloudflare or direct provider-side inbound-packet counter, and other transport/codec failure modes remain possible. This lane changed no product behavior.

## Failures, limits, and rerun

- Run 1 ended after five consecutive A-UI microphone-disable failures: `Could not complete microphone disable after 5 attempts`. Sync replies and B-off UI were observed, and repeated Sync→API requests used the same operation ID; those five attempts remain in [run 1](./toggles-run1.json) but are excluded from the successful-stage percentiles. Run 2 stopped at camera enable with the exact error `locator.click: Timeout 30000ms exceeded.` while waiting for a visible `Start Video` / `Turn on camera` button. Its prior 20 camera pairs remain in [run 2](./toggles-run2.json); [run 3](./toggles-run3.json) supplied 10 more. Camera disable has 31 successes because the failed camera-enable attempt was preceded by a successful disable.
- No toggle called `getUserMedia`; this run does **not** measure fresh device capture latency. The headless fake-device/local-stack distribution is not a production Karachi p95. B-state frame matching is incomplete for disables. Browser request and API timing clocks were correlated through journey IDs; Cloudflare call attribution has time-window uncertainty when calls overlap, mitigated by Participant and track-name checks. [Merged raw records](./merged-toggles.json) include per-toggle timestamps and server calls; [stage summary](./stage-summary.json) holds all percentile calculations.
- `pnpm dev:stop` returned `ownership: recorded supervisor 99077 no longer matches its expected command` (exit 2). After verifying PID 99077 was `node scripts/dev/cli.mjs start`, SIGTERM was sent as authorized. `pnpm dev:status` then reported `stopped`, and no Chalk containers remained running. The stack was started for this run and was **not** left running.

From the repository root, rerun with two terminals (choose a fresh `toggles-runN.json` name to retain the present raw data):

```sh
python3 scratchpad/sync-hardening-2026-09-27/lane-b2/prepare_overlay.py
CHALK_DEV_API_PORT=28080 CHALK_DEV_OBSERVABILITY=disabled \
  GOFLAGS="-overlay=$PWD/scratchpad/sync-hardening-2026-09-27/lane-b2/go-overlay.json" \
  LANE_B2_CF_TRACE_PATH="$PWD/scratchpad/sync-hardening-2026-09-27/lane-b2/cloudflare-calls.ndjson" \
  pnpm dev
```

```sh
LANE_B_KINDS=microphone,camera LANE_B_PAIRS=30 LANE_B_PAUSE_MS=300 \
  LANE_B_RTP_TIMEOUT_MS=15000 LANE_B_OUTPUT=toggles-run4.json \
  node scratchpad/sync-hardening-2026-09-27/lane-b2/measure.mjs
node scratchpad/sync-hardening-2026-09-27/lane-b2/repro-remote-video.mjs
node scratchpad/sync-hardening-2026-09-27/lane-b2/merge-timings.mjs
node scratchpad/sync-hardening-2026-09-27/lane-b2/summarize.mjs
pnpm dev:stop
```

If the same stop ownership check fails, verify the recorded supervisor command and SIGTERM that supervisor, then check `pnpm dev:status`; do not touch another lane's containers. The overlay is only for local measurement and records neither request headers nor raw SDP. The lane's JSON/NDJSON audit found no raw SDP, full Cloudflare session IDs, invite tokens, or secret-bearing fields.
