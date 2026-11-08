# Chalk SFU

A standalone Go service that forwards Participants' audio and video as a second media provider beside Cloudflare Realtime. The design and the milestone plan are in the SFU design pull request (#796). This covers milestones M1 (service skeleton with real push and pull), M2 (retry-safe lifecycle, admission, negotiated close), the media side of M4 (simulcast layer routing), the SFU side of M3 (source fencing, forwarding leases and in-place ICE restart) and the SFU side of M5 (congestion control, repair, Episode ceilings and host-health admission). The API reaches it through the `chalk_sfu` media-plane adapter.

The module is `github.com/q9labs/chalk/features/media/sfu`. It never imports `apps/api/internal`. The API adapter will translate between the public `protocol` package and its own ports.

## What it does

- **Control** on TCP 8443 over mutual TLS (TLS 1.3). The server certificate and the client CA come from files. The client certificate must also name the expected service (`SFU_CLIENT_IDENTITY`, a DNS or URI SAN), so a certificate from the right CA but another service gets 403. The listener binds all interfaces by default, because the service is public: mutual TLS and the cloud firewall guard it. Set `SFU_CONTROL_ADDR` to bind elsewhere.
- **Health**: `GET /healthz` (process is up, no identifiers) and `GET /readyz` (node incarnation, session count, packet budget, reserved packets and what a new Episode would reserve, the UDP receive and send buffers the kernel granted and the host's drops for a full buffer, and the process's goroutines, in-use heap and resident memory, plus `draining`, `allocations` and `cleanupDebt`; 503 with the same body while draining). Both sit on the same mutual-TLS listener, and `/readyz` also needs the service identity, like `/v1`.
- **Profiling**: `GET /debug/pprof/` (index, `heap`, `goroutine`, `allocs`) and `GET /debug/pprof/profile?seconds=N` (N from 1 to 15, default 15; longer is refused with 400) need the same service identity as `/readyz`. Profiles hold heap contents, so keep them out of Git and telemetry.
- **Sessions** under `/v1`, each scoped to Tenant, Episode, Participant and generation:
  - `POST /v1/sessions` creates a session. The operation ID makes a retry return the same connection ID, also after that session closed, and reusing it with another body fails with 409. The node keeps the create records of the last 4096 closed sessions. A create with a new operation ID closes the Participant's live session and replaces it, at a newer or the same generation, because the API replaces a media connection that way; an older generation is refused.
  - `POST /v1/sessions/{id}/tracks` pushes local tracks (client offer, SFU answer) or pulls remote tracks (no SDP, SFU offer). A request is all local or all remote. Failed tracks return per-track errors while the rest succeed. A push with an offer and no tracks renegotiates the connection in place, so a client's ICE restart gets an answer with the new credentials and keeps its publications and subscriptions.
  - `POST /v1/sessions/{id}/renegotiate` applies the client's answer to the pending server offer. An unanswered offer closes the session after `SFU_NEGOTIATION_TIMEOUT`.
  - `POST /v1/sessions/{id}/tracks/close` force-closes tracks by MID. Closing an absent MID succeeds.
  - `POST /v1/sessions/{id}/inspect` lists the session's tracks.
    A session or publisher outside the caller's Tenant and Episode reads as gone.
  - An offer is checked before Pion sees it: at most 64 KiB, audio and video sections only, and every section it adds must belong to a track of the request. Tracks that would exceed the publication limit fail the whole request with 429. A section without Opus (audio) or VP8 (video) gets a per-track `invalid_track` error. A session holds at most four times its publication plus subscription limit in media sections over its life, because Pion keeps stopped sections.
  - A delayed create from an older generation stays refused after the newer session closes. The node remembers the highest generation per Participant, for up to 16384 Participants. When the table is full it drops the oldest fence of a Participant with no live session, and it never drops a live session's fence; if every fence is live, a create for a new Participant gets 429. A refused create never drops a fence.
- **M2 additions**:
  - Every mutation takes an `operationId`. The session remembers the digest and the stored response of its last 256 operations, so a retry returns the first result and the same ID with another body fails with 409. The API adapter generates one ID per logical call and reuses it on its HTTP retries.
  - `POST /v1/sessions/{id}/tracks/update` changes a subscription's layer policy (`simulcast` and `paused`) without SDP. A layer change follows the same keyframe-gated switch as a pull.
  - `POST /v1/sessions/{id}/tracks/close` also does negotiated close (`force: false`): the client's offer is applied first, then the subscription stops and the SFU's answer returns. `receiveOnly` closes can never stop a publication.
  - `POST /v1/sessions/{id}/remove` ends one session. `POST /v1/episodes/end` closes every session of a Tenant's Episode and reports the count.
  - **Admission** reserves, per Episode with `n` live Participants (at least 2), `m` cameras each, microphone cost `a` and screen cost `s`: `n·(m·u + a) + n·(n-1)·(m·d + a) + n·(s + a)` packets/s. `u` is a camera's uplink (`SFU_CAMERA_UPLINK_COST`, every simulcast layer, because publishers keep sending all of them) and `d` its downlink to one subscriber (`SFU_VIDEO_STREAM_COST`, one layer). The defaults come from the SDK's camera encodings: `h` at 2.5 Mbit/s and `l` at 650 kbit/s, 30 frames/s, a frame needing `ceil(bytes/1150)` packets. That is 300 for `h` and 90 for `l`, so `d` is 300 and `u` is 390, which matches what real SDK cameras sent on a deployed node. `SFU_CAMERAS_PER_PARTICIPANT` (2 by default) is `m`: a push of one more camera gets the track error `limit_exceeded`. At the defaults a 3-person class with 2 cameras each reserves 7170 packets/s, so a 16000 budget holds two such classes and refuses the third class's first join with 429 `capacity_exceeded`; a 4-person class already reaches the 11520 Episode ceiling. A create that would push the node past `SFU_PACKET_BUDGET` is refused the same way, and the node logs a `refused` line naming the reason. `SFU_MAX_EPISODE_PARTICIPANTS` is a separate safety cap, 16 by default. A reconnect replaces its own session and is not counted twice. `/readyz` reports the budget and the reserved packets.
  - **One screen share** per Episode. A second screen publication gets the per-track error `screen_share_active`.
- **Capture sessions** (M10) give the recorder a receive-only connection to an Episode the node hosts.
  - `POST /v1/sessions` with `"kind":"capture"` creates one. `scope.participantId` names the capture and
    `scope.generation` is its capture epoch: a newer epoch replaces the older session and an older epoch is
    refused, as for a Participant. A capture never shares a name or a fence with a Participant. The Episode
    must have a live Participant session on the node, else the create reads as `session_gone`. A capture only
    pulls; a push gets 501 `unsupported_operation`.
  - A capture is not a Participant. It takes no slot against `SFU_MAX_EPISODE_PARTICIPANTS`, adds nothing to
    the Episode's reservation, and reserves packets/s of its own against the node budget for each track it
    pulls: `SFU_VIDEO_STREAM_COST` for a camera, `SFU_SCREEN_STREAM_COST` for a screen share's video and
    `SFU_AUDIO_STREAM_COST` for audio, the cost of the same track for a Participant at its top layer. A pull
    that would pass `SFU_PACKET_BUDGET` fails that track with `limit_exceeded` and counts a `node_full`
    refusal, and a closed track or closed capture returns its reservation. A Participant join sees the
    capture's reservation. An Episode holds at most `SFU_MAX_CAPTURES_PER_EPISODE`
    captures (refusal reason `capture_limit`), and one capture pulls up to `SFU_MAX_CAPTURE_SUBSCRIPTIONS`
    tracks.
  - The Episode's plan, packet ceiling, probes and congestion pauses serve the call, so they leave the capture
    out: its subscriptions start on the layer they asked for, with no startup cap, and keep it, and its packets do not make the plan lower a
    Participant's camera. Its packets count in the node's totals.
  - Forwarding follows the source lease, not the subscriber, so a revoke or lapse stops the capture's copy with
    everyone's. `POST /v1/episodes/end` and `/remove` close captures like any session. A capture that never
    connects closes after `SFU_CONNECT_TIMEOUT`, and one whose peer connection fails closes at once.
  - Compatibility: the kind is an additive field, absent for a Participant, so an API that predates it is
    unchanged. The node decodes strictly, so a node that predates the kind answers a capture create with 400
    `invalid_request` and creates nothing. `GET /readyz` lists `sessionKinds: ["capture"]` on a node that
    creates them (absent when `SFU_MAX_CAPTURES_PER_EPISODE=0`), which a caller checks before it places a
    capture. The protocol stays `v1`.
- **Source control** (M3) decides which sources may forward. A source forwards only under a live grant, which the API sends when Sync authorizes the source and renews from durable authorization.
  - `POST /v1/episodes/reserve` reserves a complete recovering Episode before any Participant rejoins, so a standby takes the whole call or refuses it instead of half-recovered calls consuming capacity through individual retry races. The body carries the operation ID, Tenant, Episode, a `generation` fence, the admitted `shape` (`participants`, `camerasPerParticipant` up to the node's limit, `screenShare` and optional `captureSlots` up to `SFU_MAX_CAPTURES_PER_EPISODE`) and `ttlSeconds` (default 30, at most 120). The node runs the same admission checks as a join, for the whole shape and under one lock: the Episode and session limits, the host guard for an Episode it does not host, mandatory media against the Episode ceiling and the packet budget. It answers the packets reserved and the expiry, or `capacity_exceeded` or `draining` (a draining node refuses every reserve). The hold counts in `/readyz` `reservedPackets` and in `allocations`, so placement and the next reserve see it, and a restart waits for it. A held Episode counts as hosted: its first rejoin is admitted even if the node started draining or the host guard closed since the reserve, while genuinely new Episodes stay blocked. A Participant create below the hold's `generation` is refused as `stale_generation`, so older media cannot take a recovered slot; the per-Participant fences cover only a Participant the node has seen, and the hold fences the Episode's first rejoin of one it has not. Each join of that Episode replaces the hold and never adds to it: the Episode reserves for the larger of its live Participants and the held ones, so the node's total stays put as Participants rejoin, and the hold is gone once they all have. The session limit counts the Participants and `captureSlots` captures that holds still promise, so no other Episode takes a slot a reserved call needs. A capture takes its held packets as its subscriptions are accepted and gives them back to the hold if a subscription ends or setup rolls back. The shape must meet the mandatory-media rule at every count from the first rejoin to its size. A hold ends at its deadline or with `POST /v1/episodes/end`, releasing whatever no join used; expiry is checked on every read of the reservations, so it is exact and idempotent. A newer reserve of the Episode replaces its hold, and one older than the hold's generation or any live Participant's is `stale_generation`. The same operation ID and body returns the first answer, also after expiry; another body is `operation_conflict`. At most 64 Episodes are held at once.
  - `POST /v1/episodes/sources` grants or revokes Participants' sources in one Tenant's Episode, 1 to 64 controls per request. Each control carries the Episode's durable control revision. The node applies a control only at or above the source's recorded revision, and a revoke wins a tie, so a duplicate, delayed or stale control never undoes a newer one. Each result says whether the control applied, the recorded revision, the lease left and the publications a revoke closed.
  - A revoke stops forwarding before it returns, and closes the source's publications admitted before it on every session of the Participant; their MIDs are retired. Controls outlive sessions, so a revoke also fences a later publication of a source that had none.
  - A grant opens a forwarding lease of `SFU_SOURCE_LEASE_TTL`, and a later grant renews it. Every egress write checks the lease when it sends, so media stops when the lease lapses even if a write stalls. A packet that arrived outside the lease is never sent, as live media or as a retransmission. A grant that opens a new lease asks the source's publications for keyframes.
  - A source no control has named waits for a grant before it forwards.
  - The node keeps the newest control of up to 16384 sources. When the table is full it evicts the oldest entry of a Participant with no live session, never one the batch names, and raises that Episode's floor to the evicted revision: a source the node no longer holds starts with no lease and refuses a control below the floor. If nothing can be evicted, the batch gets 429 `capacity_exceeded`, and a push of a new source gets the track error `limit_exceeded`, so the table never holds more than its limit.
- **Media**: Opus and VP8 on one Pion UDP socket (ICE-lite).
  - A simulcast camera's layers (`h`, `l`, at most three) are each read once. Every subscription forwards one layer: it is the pull's `simulcast.preferredRid`, or `startRid` when that is lower. With `ridNotAvailable` other than `none`, a wanted layer without RTP for one second falls back to the first active RID in ASCII order, which can be higher than the one asked for, and the subscription returns when the layer resumes. A track without RIDs always serves.
  - A switch waits for a keyframe of the new layer and asks for one, at most once per 500 ms per layer. Each subscriber gets its own continuous stream: sequence numbers, timestamps, VP8 picture IDs and TL0PICIDX are rewritten so a switch, a pause, a sequence wrap or reordering never breaks decoding.
  - A pull with `paused` forwards nothing while it keeps its MID. Inspect reports each subscription's `state` (`active` or `paused`), `reason` (`viewer`, `source_inactive`, or `source_unauthorized` while the source's lease does not allow forwarding), `revision`, and requested and effective RID, and each publication's layers. A publication and its layers read inactive while the lease does not allow forwarding, even if RTP still arrives. The revision also rises when a grant opens a forwarding window and when the window ends by revoke or lapse, but not on a renewal.
  - Each video layer keeps one second of packets (400 KiB for `h` and for a camera without RIDs, 320 KiB for a screen, 128 KiB for other layers), shared by its subscribers. A subscriber's NACK is answered from it with the sequence number that subscriber first saw, on the RTX stream when the subscriber negotiated one. Keyframe requests go to the layer the subscriber forwards.
  - Streams nobody forwards are still read and discarded, and Pion's per-stream buffers are capped at 128 KiB, so no buffer grows.
  - The forwarding path allocates nothing per packet; `TestForwardingAllocatesNothing` keeps it that way.
- **Congestion and repair (M5)**:
  - Publishers get transport-wide feedback from the node to estimate their uplink. The node asks a publisher for lost video itself: at most 64 lost packets per layer, each asked for at most three times 60 ms apart after a 5 ms reorder grace, and a keyframe request after that. Repairs arrive over RTX, named by SSRC or, for simulcast, by the repaired RID.
  - Every subscriber has its own downlink transport. It rewrites transport-wide sequence numbers, paces at its estimate, and estimates the downlink from the subscriber's feedback with a GCC-style delay and loss controller. Audio never waits behind video and repairs leave first. A full pacer queue drops video, which the subscriber's NACK recovers. The queue holds at least `SFU_PACER_QUEUE_BYTES` and at least 500 ms of the subscriber's video rate, up to four times that setting, so a short scheduler stall on a shared host does not drop video. Retransmissions are capped at a quarter of the proven rate (at least 100 kbit/s), and one packet is resent at most once per 100 ms.
  - Before raising a subscriber, the transport proves spare capacity with padding on the RTX stream. A failed probe backs off, doubling to at most 8 s. At most two transports probe at once, and none probes while its pacer queue holds video.
  - Every 100 ms each subscriber's estimate is spent on audio and repair first, then on video layers within 95% of the estimate (85% while congested). A raise needs the proven rate and 500 ms of headroom, and one layer changes per tick. A new pull starts on the lowest layer and climbs. SDK layer requests are ceilings. A tile keeps a layer above its lowest only while the tiles after it keep room for their lowest layers, so a dip in the estimate lowers the early tiles before it pauses a late one.
  - The control loop measures its own lateness, and the guard measures CPU steal. A tick later than 200 ms, or steal of 5% or more in the last second, marks host pressure for 2 s (at most 10 s unbroken). While it holds, no tile drops, pauses or raises, the delay controller does not lower the estimate, running probes end without backoff, and pacer drops do not mark a transport congested. Loss still lowers the estimate, and a transport whose receiver reports heavy loss (a stall delays packets but does not lose them) gets no pressure excuse for 2 s, so a congested path still backs off. A delay decrease also waits one control tick, so feedback that arrives before the control loop notices a stall cannot lower the estimate. The node logs `control loop stalled`, and telemetry carries `controlStalls`, `controlStallMaxMs` and `hostPressureMs`, the time pressure has held since start.
  - When a camera's lowest layer has not fit for a second and the path delivers less than 95% of what the pacer sends, the subscription pauses with reason `congestion` and keeps its MID and audio. Video returns after the lowest layer has fit with 15% headroom for 3 s; repeated pauses back off from 2 s to 16 s.
  - Each Episode is held to its ceiling: the lower of its reservation, `SFU_EPISODE_PACKET_CEILING` ingress-plus-egress packets/s (repairs included, probes not, because a probe is the allocator's own measurement) and the node budget. An Episode of more than `SFU_LARGE_CALL_PARTICIPANTS` shows small tiles: it reserves `SFU_SMALL_TILE_STREAM_COST` for every camera downlink but one featured Participant's, and its ceiling is the node budget. The node refuses to start if a call of `SFU_LARGE_CALL_PARTICIPANTS` Participants with a screen share needs more than `SFU_EPISODE_PACKET_CEILING`, because a call that shrinks takes that ceiling back; it checks only when `SFU_MAX_EPISODE_PARTICIPANTS` lets a call pass that size. A viewer whose tiles read as large, such as a 2x display, asks for more than the reservation covers; the plan then caps cameras at their lowest layer, so the Episode never sends more than it reserved. Over it, cameras drop to their lowest layer and then pause for every subscriber, the least recent speaker first; they rise again, the most recent speaker first, after the Episode has stayed under 90% of its ceiling for 2 s. Ingress is not lowered, because publishers keep sending every layer until dynacast (M9). So a join or screen share is refused when every microphone to every Participant, every camera's `SFU_CAMERA_UPLINK_COST` uplink and the screen share could not fit under the ceiling: at the defaults, the tenth Participant, or the ninth with a screen share. Because admission keeps that mandatory part under the ceiling and the reservation covers every camera's top layer, an admitted Episode at real SDK rates is never paused wholesale.
  - The node refuses new Episodes, for the reason it then reports as `admissionReason`, when over `SFU_GUARD_WINDOW` (a full window must pass after boot first): CPU steal exceeds `SFU_GUARD_MAX_STEAL_PERCENT` (`cpu_steal`), CPU busy time exceeds `SFU_GUARD_MAX_BUSY_PERCENT` (`cpu_busy`, 90), the pacers dropped more than `SFU_GUARD_MAX_PACER_DROP_PERCENT` of the video they dropped or sent, at least 100 packets (`pacer_drops`, 5), or the host's UDP receive or send buffer errors exceed `SFU_GUARD_MAX_UDP_ERRORS_PER_SECOND` (`udp_buffer_errors`, 5, read from `/proc/net/snmp`). It also refuses while Go scheduler latency p99 over the last 10 s exceeds `SFU_GUARD_MAX_SCHEDULER_LATENCY` (`scheduler_latency`, 20 ms): runnable goroutines waiting that long for a CPU means the host cannot keep up, whether from steal, busy time or a stall, and the short window reopens admission within seconds of the stall ending. Pacer queue delay is reported but does not close admission, because a subscriber's own pace sets most of it: a new transport draining keyframes at its first estimate waits 50 ms or more on an idle node. It counts video and repair only, because audio never queues, and a dropped video packet counts as the time the full queue would have taken to drain. The node logs the reason and the readings when admission closes or reopens, and every refusal logs its reason. Live Episodes still admit their Participants. `/readyz` reports steal, scheduler latency, queue delay and the admission reason.
  - Inspect reports each subscriber's transport (estimate, proven rate, feedback age, queued bytes, packets sent per class, pacer drops, repairs cut, probes), its Episode's measured packets/s (probes included, so it can read above the ceiling while no camera is lowered), ceiling and capped or paused cameras, and how many packets each ingress layer asked for again and got back over RTX.

- **Telemetry**: with `SFU_OTLP_ENDPOINT` set, the node exports metrics over OTLP/HTTP every `SFU_OTLP_INTERVAL` (10 s), the pipeline the API uses, as `service.name=chalk-sfu` with its incarnation as `service.instance.id`. The exporter reads its token and dataset from `OTEL_EXPORTER_OTLP_METRICS_HEADERS`. Every instrument is asynchronous: one callback reads the control loop's latest tick at export time, and the control loop adds each stream's growth to node totals every 100 ms, so the packet path does no extra work. A stream that closes between two ticks loses at most that tick's counts. Metrics carry no Tenant, Episode, Participant, session or address; their only attributes are `chalk.sfu.direction` (`in`, `out`), `chalk.sfu.media_kind` (`audio`, `video`, and `repair` and `probe` out), `chalk.sfu.refusal_reason` and `chalk.sfu.admission_reason`. [Observability](../../../docs/observability.md#own-sfu-congestion-repair-and-admission) lists them. Without an endpoint the node still logs `media telemetry` lines to the host journal and reports its load on `/readyz`.

## Run it

```sh
cd features/media/sfu
SFU_TLS_CERT_FILE=server.pem SFU_TLS_KEY_FILE=server.key \
SFU_CLIENT_CA_FILE=ca.pem SFU_CLIENT_IDENTITY=chalk-api \
SFU_ANNOUNCE_IPS=203.0.113.10 \
go run ./cmd/sfu
```

| Setting                                 | Default         | Meaning                                                               |
| --------------------------------------- | --------------- | --------------------------------------------------------------------- |
| `SFU_CONTROL_ADDR`                      | `:8443`         | Control listener.                                                     |
| `SFU_UDP_ADDR`                          | `:50000`        | The one UDP socket every peer shares.                                 |
| `SFU_ANNOUNCE_IPS`                      | host interfaces | Addresses placed in ICE candidates (comma-separated).                 |
| `SFU_ICE_LOOPBACK`                      | `false`         | Offer loopback candidates; local runs only.                           |
| `SFU_TLS_CERT_FILE`, `SFU_TLS_KEY_FILE` | required        | Server identity.                                                      |
| `SFU_CLIENT_CA_FILE`                    | required        | CA that signs the API's client certificate.                           |
| `SFU_CLIENT_IDENTITY`                   | required        | DNS or URI SAN the API's certificate must carry.                      |
| `SFU_MAX_SESSIONS`                      | `64`            | 1 to 1024.                                                            |
| `SFU_MAX_PUBLISHED_PER_SESSION`         | `8`             | 1 to 32.                                                              |
| `SFU_MAX_SUBSCRIPTIONS_PER_SESSION`     | `32`            | 1 to 128.                                                             |
| `SFU_MAX_CAPTURES_PER_EPISODE`          | `2`             | 0 to 8. 0 turns capture sessions off.                                 |
| `SFU_MAX_CAPTURE_SUBSCRIPTIONS`         | `64`            | 1 to 128. Tracks one capture session pulls.                           |
| `SFU_MAX_REQUEST_BYTES`                 | `262144`        | 4096 to 1048576.                                                      |
| `SFU_PACKET_BUDGET`                     | `16000`         | Packets/s budget; `deploy` sets `22000` on 1 vCPU and `36000` on 2.   |
| `SFU_AUDIO_STREAM_COST`                 | `50`            | Reserved packets/s of one audio stream.                               |
| `SFU_SCREEN_STREAM_COST`                | `210`           | Reserved packets/s of one screen share.                               |
| `SFU_MAX_EPISODE_PARTICIPANTS`          | `16`            | 1 to 64. Live sessions allowed in one Episode.                        |
| `SFU_EPISODE_PACKET_CEILING`            | `11520`         | Most packets/s one Episode may carry.                                 |
| `SFU_LARGE_CALL_PARTICIPANTS`           | `6`             | 0 to 64. Past this size a call shows small tiles; 0 turns that off.   |
| `SFU_SMALL_TILE_STREAM_COST`            | `90`            | Reserved packets/s of one low-layer camera to one subscriber.         |
| `SFU_HISTORY_HIGH_BYTES`                | `409600`        | Repair history of `h` and of a camera without RIDs.                   |
| `SFU_HISTORY_LOW_BYTES`                 | `131072`        | Repair history of other camera layers.                                |
| `SFU_HISTORY_SCREEN_BYTES`              | `327680`        | Repair history of a screen share.                                     |
| `SFU_PACER_QUEUE_BYTES`                 | `131072`        | Video one subscriber's pacer may hold at least.                       |
| `SFU_GUARD_MAX_STEAL_PERCENT`           | `3`             | CPU steal that closes admission to new Episodes.                      |
| `SFU_GUARD_MAX_SCHEDULER_LATENCY`       | `20ms`          | Go scheduler latency p99, over 10 s, that closes admission.           |
| `SFU_GUARD_WINDOW`                      | `30s`           | Window both guard signals are measured over.                          |
| `SFU_NEGOTIATION_TIMEOUT`               | `10s`           | How long a server offer waits for its answer.                         |
| `SFU_CONNECT_TIMEOUT`                   | `60s`           | How long a new session may take to connect.                           |
| `SFU_SHUTDOWN_TIMEOUT`                  | `15s`           | Graceful stop budget.                                                 |
| `SFU_UDP_RECEIVE_BUFFER`                | `8388608`       | Socket receive buffer to request, 256 KiB to 64 MiB.                  |
| `SFU_UDP_SEND_BUFFER`                   | `8388608`       | Socket send buffer to request, 256 KiB to 64 MiB.                     |
| `SFU_UDP_BATCH`                         | `true`          | Batch media socket reads and writes (Linux). `false` is the rollback. |
| `SFU_VIDEO_STREAM_COST`                 | `300`           | Packets/s of a camera's top layer to one subscriber.                  |
| `SFU_CAMERA_UPLINK_COST`                | `390`           | Packets/s of a camera's uplink, every layer.                          |
| `SFU_CAMERAS_PER_PARTICIPANT`           | `2`             | Cameras one Participant may publish, 1 to 8.                          |
| `SFU_GUARD_MAX_BUSY_PERCENT`            | `90`            | Host CPU busy time that closes admission.                             |
| `SFU_GUARD_MAX_PACER_DROP_PERCENT`      | `5`             | Share of dropped video that closes admission.                         |
| `SFU_GUARD_MAX_UDP_ERRORS_PER_SECOND`   | `5`             | UDP buffer errors a second that close admission.                      |
| `SFU_SOURCE_LEASE_TTL`                  | `15s`           | How long a grant lets a source forward, 10s to 2m.                    |

## Deploy

Set `net.core.rmem_max`, `net.core.rmem_default`, `net.core.wmem_max` and `net.core.wmem_default` to 8 MiB (`8388608`) on the host, for example in `/etc/sysctl.d/90-chalk-sfu.conf`. The kernel caps a socket's buffers at `rmem_max` and `wmem_max`, and Linux defaults them to about 208 KiB, which a burst of video from many publishers overflows as UDP receive errors, and the pacers' bursts overflow as UDP send errors. At start the node logs the sizes it requested and the sizes the kernel granted, and warns when it got less. `/readyz` reports the granted sizes as `host.udpReceiveBufferBytes` and `host.udpSendBufferBytes` and the host's `RcvbufErrors` and `SndbufErrors` as `host.udpReceiveBufferErrors` and `host.udpSendBufferErrors`, so a rising count shows loss from a full buffer. `deploy` sets the send-buffer sysctls on a node created before they existed.

`POST /v1/drain` drains the node and keeps it running; SIGUSR1 does the same. `/readyz` then answers 503 with its usual body and `draining: true`, so the API places no new Episode on it (the previous API release reads any non-200 as the node having left placement), and a new Episode is refused. Live calls continue, and their Participants can still join and reconnect. Both calls are idempotent, and `POST /v1/undrain` reopens admission for a restart that was called off. Each answers with the drain state: `allocations` counts the node's sessions, capture sessions included (`Node.allocations`), and `cleanupDebt` counts closes that have begun and not finished. A restart interrupts no call once both are zero. `sourceLeases` counts the source leases open now and only informs: leases are soft state that a restart drops, and the API keeps renewing standing grants while no session exists, so they do not hold a restart. The node logs `sfu drained` when that happens after SIGUSR1. SIGINT or SIGTERM stops it: in-flight requests finish, then every session, the control listener and the UDP socket close.

[`infra/`](infra) is the OpenTofu module for one DigitalOcean node: the Droplet, tagged `chalk-sfu` and `chalk-sfu-staging` or `chalk-sfu-prod`, a cloud firewall that opens media UDP to everyone and the control port only to the API's addresses, and a first-boot script that sets the receive buffer, a matching host firewall and a rootless `chalk-sfu` user. [`infrastructure/sfu`](../../../infrastructure/sfu) applies it per environment. [`deploy/`](deploy) holds the image, the Quadlet unit and two scripts:

- `deploy/certs <staging|production> <ca|server|api|operator>` issues certificates from the environment's service CA. The CA key lives in 1Password; issued files go to `~/.config/chalk-sfu/<env>`, never into Git. The API's certificate keeps its key and names and adds the identity the SFU requires, `spiffe://chalkmeet.com/environment/<env>/api`, with client auth. Rotate a certificate by issuing it again and redeploying; the server certificate lasts 180 days and the API's 365.
- Metrics export needs `~/.config/chalk-sfu/<env>/otlp-headers`, holding the `OTEL_EXPORTER_OTLP_METRICS_HEADERS` value, for example `Authorization=Bearer%20<ingest token>,X-Axiom-Dataset=<metrics dataset>`. Use an ingest-only token for the API's metrics dataset and keep it in 1Password. Deploy installs the file as the Podman secret `chalk-sfu-otlp-headers`, which reaches the container as that environment variable, and sets `SFU_OTLP_ENDPOINT` (default `https://api.axiom.co`; override it with `SFU_OTLP_ENDPOINT`). Without the file, deploy warns and the node exports nothing.
- `deploy/deploy <staging|production> <node address> [--force|--firewall-only]` first makes the node's ufw allow exactly the control and SSH sources of its cloud firewall (`--firewall-only` stops there, with no restart), then builds the image at the current commit, loads it into the node's Podman, installs the certificates as Podman secrets, renders the settings for the node's size (`SFU_PACKET_BUDGET` 22000 on 1 vCPU and 36000 on 2, which admit 3 and 5 three-person classes at 7,170 reserved packets/s each, set by the CPU steal a shared vCPU shows under load (see [capacity calibration](../../../docs/sfu/capacity-calibration.md)); `SFU_GUARD_MAX_STEAL_PERCENT` 40 on production and 25 on staging; `GOMEMLIMIT=384MiB` on 1 GiB of memory, 768 MiB on 2 GiB), drains the running node with `POST /v1/drain` through the operator tunnel until `/readyz` reports zero `allocations` and `cleanupDebt`, restarts it and checks `/readyz` through an SSH tunnel. If `SFU_DRAIN_TIMEOUT` (default 3600 seconds) ends first, deploy reopens the node with `POST /v1/undrain` and exits, because a restart then would be a disruptive replacement that cuts live calls; `--force` accepts it. It fails when the granted receive buffer is below 8 MiB. Running it twice converges on the same state.
- **First upgrade onto the lease-aware drain needs `--force` once.** A node that runs a build from before #951 counts standing source leases as allocations, so its drain stays above zero while it serves no call (staging showed allocations 2 with 0 sessions and 0 Episodes for over ten minutes). Run `deploy/deploy <environment> <node address> --force` once, when no live call needs the node. Every later deploy drains to zero and restarts without `--force`. To undo, redeploy the previous image with `--force`.

## Tests

### Shared staging node

Every lane that drives the staging SFU must run its entire test, rerun, fault test or soak through `scripts/staging-sfu/staging-lock` before touching the node; workflows also use Actions concurrency group `chalk-staging-sfu` with cancellation disabled.

From the repository root:

```sh
scripts/staging-sfu/staging-lock --holder lane-name --purpose retest --run-id run-label -- your-test-command
```

The helper uses the existing Git remote credentials (`GITHUB_TOKEN` with
`contents:write` in CI, normal Git authentication on a Mac). It atomically
creates `refs/heads/locks/staging-sfu`, whose only file is a JSON lease record:
holder, purpose, run ID, acquisition time, expiry and an ownership token.
Use plain labels, not customer names, URLs or secrets. The lock branch must
remain outside release branch protections. Expired leases are taken over with
compare-and-swap; renewal and release cannot overwrite a newer owner. Release
expires the record instead of deleting it, preserving the previous holder and
times. The default wait is 10 minutes and the TTL is 180 seconds, renewed every
60 seconds. A renewal failure stops the workload before the lease expires.
Do not detach a workload from the helper: the lease covers its process tree,
not a separately launched background test. Cancellation releases the lease;
runner loss leaves a bounded expiry. Do not edit or delete the lock ref by hand.

The disposable primary/standby fleet in `scripts/bench/bench` and M11's
`scripts/bench/faults` does not target shared staging and needs no staging lease.
Using staging instead requires the same wrapper. This lease is cooperative:
an older checkout or an unwrapped command can still interfere. The nightly
latency card therefore also records observed foreign Episodes and connections
from API logs; see the [scorecard](../../scorecard/README.md#staging-contention).

Run the heavy runs on Instabox (`box run -- '...'` from the repository root), not on a laptop.

1. **Loopback integration test** starts the real HTTP service and two real Pion peers. Peer A pushes known RTP. Peer B pulls it and answers the SFU's offer through Renegotiate. It asserts payloads and increasing sequence numbers, close, inspect, duplicate create, a wrong client certificate, a cross-Tenant pull and that every peer, listener, socket and goroutine is gone at the end.

   ```sh
   cd features/media/sfu && go test -race -count=1 ./...
   ```

   `scripts/gate.sh` runs these with format, tidy and vet checks. The repo gate runs it as the `sfu` lane when anything under `features/media/sfu` changes.

2. **Chromium check** builds and starts the service, then drives headless Chromium with a fake camera and microphone. Connection A pushes with the SDK's shape (max-bundle, sendonly transceivers, camera simulcast `h`/`l`). Connection B pulls and answers the server offer. It passes when B decodes video frames and receives audio packets. With simulcast, connection C pulls `l` while B pulls `h`; the check stops and restarts each encoding twice and asserts that both keep decoding on the expected layer with their MIDs and no new SDP. It then prints each encoding's resolution and encode time. It needs Playwright's Chromium, so it is not part of the CI gate.

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec playwright install chromium
   cd features/media/sfu && node tests/browser/chromium-check.mjs
   SIMULCAST=0 node tests/browser/chromium-check.mjs   # single-encoding camera
   ENCODINGS=3 node tests/browser/chromium-check.mjs   # adds a quarter-size "q" encoding
   ```
