# Lane D — Is Cloudflare Realtime SFU consistently slow from Karachi?

**Measurement date:** 2026-09-27 UTC  
**Vantage:** one Mac in Karachi, Pakistan; this is not a regional survey.

## Finding

The direct probe did **not** reproduce Chalk's reported 1.7 s p50, 9.5 s p95, 6% HTTP 503, or 10 s `create_connection` timeouts. Across 1,100 direct SFU HTTPS calls in 100 complete cycles, there were no HTTP/transport errors, 503s, or per-track errors. Aggregate API total latency was **254 ms p50 / 784 ms p95 / 1,084 ms p99 / 2,974 ms max**. New-session creation was 256/548/1,381/2,471 ms (p50/p95/p99/max); no call reached the probe's 30 s timeout.

The exact **close camera → republish camera → B pulls the new camera** sequence succeeded in **100/100 cycles**. B's first decoded frame after the republished pull arrived in **572 ms p50 / 861 ms p95 / 1,161 ms p99 / 1,287 ms max**. From the start of A's close-track API request to that frame, the distribution was 1,118/1,728/2,173/5,042 ms. This test did not reproduce the reported “B never receives video again” failure.

The slow part in this sample is **new-session/subscriber startup as experienced end-to-end**, not steady media forwarding or the established-session republish path. B's initial first decoded frame took 4,444 ms p50 / 7,208 ms p95 / 8,413 ms p99 / 9,292 ms max. That measurement includes HTTPS calls, browser offer/answer work, ICE gathering, renegotiation, and decode—not just SFU forwarding. Media candidate-pair RTT was much lower at the median (9–34 ms by stage), though its p95 reached 212–236 ms and its maximum reached 855 ms. The control API itself has moderate latency and rare multi-second tails, but not the persistent 1.7/9.5 s pattern seen in Chalk's logs.

**Interpretation:** direct SFU behavior from this one Karachi machine, during this 31-minute window, does not explain the Chalk symptom by itself. The initial join/frame path is slow enough to matter, and API tail spikes exist, but this run points toward investigating Chalk's timing boundaries, client-side negotiation/ICE, and lifecycle sequencing. That is an inference, not proof that Chalk is at fault: the timing and code paths are not identical, and the run cannot characterize other cities, networks, or times.

## Probe and timing boundaries

- Used the local **development** Realtime SFU application resolved in-process from the 1Password `dev` vault. No Chalk dev stack was started. Credential values, bearer headers, session IDs, and SDP were not written to the raw files.
- A small Node + Playwright probe launched installed Chrome with `channel: "chrome"`, fake media devices, and two independent browser contexts. For each cycle, A created a session and published fake audio and video; B created a session and pulled both; A closed its video track and published a new track under the same `camera` name; B pulled that publication and renegotiated.
- The scheduled run started at **2026-09-27 14:56:22.659 UTC** and the last cycle started at **15:27:43.667 UTC**, a **31m21.008s** first-to-last start span. All 100 cycles completed. There were 1,100 SFU API calls, 100 HTTPS baseline requests, and 100 `/cdn-cgi/trace` requests.
- API timings are milliseconds from the same Node process. `ttfbMs` is request start to the HTTPS response callback (response headers); `totalMs` is request start to response-body completion. Every call records DNS, TCP connect, TLS handshake, TTFB, total, status, request error, and sanitized per-track error fields. Percentiles below use nearest rank. SDP is never recorded.
- The browser's selected `RTCIceCandidatePairStats.currentRoundTripTime` and selected remote candidate address/type were captured at each stage. Every sampled peer was `connected` with a `succeeded` pair. All 400 remote candidate snapshots selected **141.101.90.0** (`host` candidate); local candidates were `srflx`. Local candidate addresses were removed from the raw artifact as unnecessary workstation-network identifiers.
- The probe waits for ICE gathering to complete, or submits an answer after a 2.5 s period with no new candidate (30 s cap). Chrome sometimes remained in `gathering`; the run records this fallback policy but not per-negotiation fallback duration/use. Initial first-frame time therefore includes client-side ICE/signaling and may include that quiet-period wait. Do not read it as pure media-forwarding latency.

## Direct API results

All durations are **p50 / p95 / p99 / max, milliseconds**, for `totalMs`. `TTFB p95` is shown separately. Create-session responses were HTTP 201; other API operations were HTTP 200. Every row had zero HTTP/transport errors and zero per-track error responses.

| API operation                                          |   n | HTTP status |  Total p50 / p95 / p99 / max (ms) | TTFB p95 (ms) | HTTP/transport errors; per-track errors |
| ------------------------------------------------------ | --: | ----------- | --------------------------------: | ------------: | --------------------------------------: |
| `POST /sessions/new` — A and B                         | 200 | 201 × 200   | 255.9 / 547.5 / 1,381.1 / 2,471.4 |         547.1 |                                0/200; 0 |
| `POST /tracks/new` — A publishes initial audio + video | 100 | 200 × 100   | 601.7 / 816.8 / 1,255.1 / 1,337.7 |         816.8 |                                0/100; 0 |
| `POST /tracks/new` — B pulls initial audio + video     | 100 | 200 × 100   | 769.4 / 923.8 / 1,258.7 / 1,417.5 |         922.5 |                                0/100; 0 |
| `PUT /renegotiate` — initial B pull                    | 100 | 200 × 100   |   245.6 / 465.8 / 771.3 / 1,353.5 |         465.7 |                                0/100; 0 |
| `PUT /tracks/close` — A closes camera                  | 100 | 200 × 100   |   250.4 / 386.4 / 809.4 / 2,973.8 |         372.1 |                                0/100; 0 |
| `POST /tracks/new` — A republishes camera              | 100 | 200 × 100   |   257.5 / 390.3 / 893.1 / 1,073.8 |         390.2 |                                0/100; 0 |
| `POST /tracks/new` — B pulls republished camera        | 100 | 200 × 100   |     242.3 / 327.2 / 434.5 / 532.0 |         327.1 |                                0/100; 0 |
| `PUT /renegotiate` — B's republished pull              | 100 | 200 × 100   |     240.4 / 387.8 / 498.7 / 530.3 |         387.8 |                                0/100; 0 |
| `PUT /tracks/close` — publisher cleanup                | 100 | 200 × 100   |     239.4 / 323.4 / 554.4 / 701.5 |         323.2 |                                0/100; 0 |
| `PUT /tracks/close` — subscriber cleanup               | 100 | 200 × 100   |     236.1 / 316.5 / 694.1 / 855.7 |         315.9 |                                0/100; 0 |

Across all 1,100 SFU calls, TTFB was 253.4/783.7/1,083.5/2,973.6 ms and total was 253.7/783.7/1,084.1/2,973.8 ms. **1,098 calls reused a keep-alive connection**; only two established a new API socket. For those two new sockets, DNS took 4.9–20.0 ms, TCP connect 23.8–104.7 ms, and TLS handshake 29.5–142.9 ms. The zero setup timings on reused rows mean no new DNS/connect/TLS work was done for that call; they do not mean a fresh connection took zero time.

## HTTPS baseline, Cloudflare colo, and media

| Request                                                  |        n/status |  Total p50 / p95 / p99 / max (ms) |  TTFB p50 / p95 / p99 / max (ms) |
| -------------------------------------------------------- | --------------: | --------------------------------: | -------------------------------: |
| Static Cloudflare-hosted Realtime API documentation page | 100 / 200 × 100 | 120.5 / 419.3 / 1,335.1 / 1,762.1 | 58.6 / 344.2 / 1,242.2 / 1,743.5 |
| `www.cloudflare.com/cdn-cgi/trace`                       | 100 / 200 × 100 |      32.5 / 180.6 / 504.2 / 755.6 |                                — |

All 100 trace responses reported colo **`LHE`**. That identifies the trace request's Cloudflare HTTPS edge observation, not necessarily the selected WebRTC media node; I do not infer the SFU node's physical location from it.

| WebRTC stats stage            | RTT p50 / p95 / p99 / max (ms) | Selected remote candidate |
| ----------------------------- | -----------------------------: | ------------------------- |
| A publisher, initial          |            9 / 212 / 536 / 855 | `141.101.90.0`, `host`    |
| B subscriber, initial         |           34 / 236 / 401 / 801 | `141.101.90.0`, `host`    |
| A publisher, after republish  |           11 / 229 / 336 / 536 | `141.101.90.0`, `host`    |
| B subscriber, after republish |           34 / 212 / 239 / 260 | `141.101.90.0`, `host`    |

| B first decoded frame                               |   n |    p50 / p95 / p99 / max (ms) | Timeouts |
| --------------------------------------------------- | --: | ----------------------------: | -------: |
| Initial A audio/video pull                          | 100 | 4,444 / 7,208 / 8,413 / 9,292 |        0 |
| Pull after A closes and republishes video           | 100 |     572 / 861 / 1,161 / 1,287 |        0 |
| A close-request start → B decoded republished frame | 100 | 1,118 / 1,728 / 2,173 / 5,042 |        0 |

The largest close-to-frame observation was 5.042 s; that cycle's close call itself took 2.974 s. The close API p95 was 386 ms, and the republish, B pull, and renegotiation API p95s were 390, 327, and 388 ms respectively. This isolates a rare close-call tail rather than a consistently slow republish sequence.

## Failures and cleanup

- In the scheduled run: **0/1,100** failed HTTP/transport calls, **0/1,100** API responses with per-track errors, **0/100** failed cycles, **0/100** initial or republished frame timeouts, and **0 HTTP 503s**.
- An earlier excluded calibration attempt failed before publishing any tracks. Its exact error was: `page.evaluate: Error: ICE gathering timed out`. It had created one unconnected SFU session; its session ID was not retained. Cloudflare documents that an unconnected session can expire before its first track/DataChannel operation. The Connection API documents session inspection and track closure, but no separate session-delete operation. I cannot independently verify that one calibration allocation after losing its ID.
- For the successful pilot and all 100 scheduled cycles, track cleanup calls for A and B returned HTTP 200 with no per-track errors; browser PeerConnections were closed and fake media tracks stopped. The final run ended after cleanup at 15:27:53 UTC, and the machine remained idle more than 30 seconds afterward. Cloudflare's teardown guidance is to close resources/tracks and the endpoint PeerConnection; the API operation list has no session-delete route. ([Connection API](https://developers.cloudflare.com/realtime/sfu/api/), [connection patterns](https://developers.cloudflare.com/realtime/sfu/get-started/connection-patterns/), [session setup and lifetime](https://developers.cloudflare.com/realtime/sfu/concepts/sessions-tracks/), [limits and timeouts](https://developers.cloudflare.com/realtime/sfu/platform/limits/))

## Cloudflare status and public reports

- At the end of the measurement, Cloudflare listed **Realtime SFU operational**, with no Realtime SFU incident days in the prior 30 days and three incident days in the prior 90 days. ([Cloudflare status services](https://www.cloudflarestatus.com/services))
- A separate **Asia-Pacific Network** incident was still open as a minor impact. Cloudflare said multiple subsea cable outages had caused congestion between Tokyo and Singapore datacenters and that it was mitigating reduced regional capacity; the incident lists the Network component, not Realtime SFU. This overlaps the test window and is a possible network confound, not evidence that SFU was affected. ([incident detail](https://www.cloudflarestatus.com/incidents/8wmvkv5jkf15))
- Cloudflare's June 12, 2025 postmortem says Realtime SFU could not create new sessions during that outage while existing connections were maintained, reducing traffic to 20% of normal during the impact window. That is a historical availability incident, not evidence of ongoing Karachi latency. ([postmortem](https://blog.cloudflare.com/cloudflare-service-outage-june-12-2025/))
- The closest recent public community report found was a July 2026 issue where `POST datachannels/new` returned `internal_error` / `Backend error` and a WAW Ray identifier. It describes an error, not latency, and is not a South Asia or Middle East report. A May 2025 issue reported a video-resolution mismatch, also not latency. I found no public 2025–2026 report specifically attributing Realtime SFU latency to Pakistan/South Asia or UAE/Oman/Saudi Arabia; this is a bounded public search, not proof that no such reports exist. ([July 2026 issue #28](https://github.com/cloudflare/realtime-examples/issues/28), [May 2025 issue #16](https://github.com/cloudflare/realtime-examples/issues/16))

## Limits and artifacts

This is one machine, one Karachi network path, one Cloudflare development app, one 31-minute window, and synthetic Chrome media. It does not measure call quality between two physically separate users or establish behavior from UAE, Oman, Saudi Arabia, or other Pakistani networks. The static documentation request is a same-machine Cloudflare HTTPS baseline, not a matched SFU control-plane endpoint. RTT is the browser's selected candidate-pair estimate, not a one-way media-delay measurement. First-frame time includes client signaling/ICE and decoding as described above.

- [100-cycle raw JSONL](lane-d/raw-20260927T145617618Z.jsonl)
- [100-cycle aggregate JSON summary](lane-d/summary-20260927T145617618Z.json)
- [Probe source](lane-d/probe.mjs)
- [Excluded failed calibration raw record](lane-d/raw-20260927T145020225Z.jsonl)
- [Excluded successful one-cycle calibration](lane-d/raw-20260927T145342437Z.jsonl)
