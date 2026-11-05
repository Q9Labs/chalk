# Chalk SFU v1

Status: implementation proposal. Scope: a second media provider, not a new call
protocol. Singapore (`sgp1`) is the deployment region. This document does not
authorize provisioning or rollout. Follow [milestones](milestones.md).

## Decision and scope

Use Go, `pion/webrtc/v4` and `pion/interceptor`. Keep Chalk's API, Sync,
publication references and SDK signaling flow. Add a Chalk adapter beside the
Cloudflare adapter; do not adopt LiveKit's room protocol or SDK.

Pion supplies WebRTC and RTCP primitives, not a finished SFU. Chalk still owns
packet routing, sequence translation, pacing, allocation and lifecycle fencing.
The [Pion examples](https://github.com/pion/webrtc/blob/main/examples/README.md)
cover forwarding, simulcast and ICE restart; the
[interceptors](https://github.com/pion/interceptor) include NACK, TWCC and GCC.
Pin reviewed module versions in M1 rather than copying versions from old research.

Borrow narrowly from LiveKit's `pkg/sfu` layer selectors, RTP translation and
stream allocator only when this is smaller than implementing them. It is
[Apache-2.0](https://github.com/livekit/livekit/blob/master/LICENSE).
Every copied unit needs its upstream commit, original copyright/license headers,
applicable NOTICE text, local changes and behavioral tests in
**features/media/sfu/THIRD_PARTY_NOTICES.md** (planned). Do not import a room server to get an
allocator, or assume code built against LiveKit's Pion fork fits stock Pion.

V1 goals:

- Audio, camera, screen and screen audio, with the existing join/publish/pull/close
  flow and bounded recovery. Browser and React Native clients share the SDK path.
- Two-layer camera simulcast; independent subscriber quality; TWCC-controlled
  sending; bounded NACK/RTX recovery. No transcoding.
- One SFU node per environment; internal canaries before external adoption.
- Initially at most **eight active Participants per own-SFU Episode**, enforced
  at admission, with a separate node-wide resource budget. Cloudflare retains
  the existing larger admission limit.

Non-goals: recording/transcription capture, global routing, cross-node media,
seamless node failover, a 500-person full-mesh video promise, AV1/VP9 SVC,
end-to-end encryption beyond DTLS-SRTP, or a replacement for Sync/Postgres.
Do not select this provider for Spaces requiring recording or transcription;
reject attempts to start either on an own-SFU Episode before reserving work.
Supporting the separate capture port is a later milestone, not an implicit
consequence of implementing live signaling.

## Verified baseline and compatibility inventory

References below describe commit `570a3d32a996fd273e75363f9ccd08421a2197ff`.
Paths and line numbers are evidence for current behavior, not proposed APIs.
The SDK is now under `sdks/typescript/`, not `packages/`.

| Current seam | Evidence (`file:line`) | V1 obligation |
| --- | --- | --- |
| Lifecycle port: EnsureEpisode, CreateJoin, RemoveParticipant, EndEpisode, EpisodeUsage; optional ResumeJoin | `apps/api/internal/mediaplane/service.go:36` | Implement lifecycle as well as track signaling; retries cannot duplicate joins. |
| AddTracks, Renegotiate, InspectSession, UpdateTracks, CloseTracks are separate optional ports | `apps/api/internal/mediaplane/signaling.go:101` | Implement all five. A basic push/pull example alone is insufficient. |
| Only `cloudflare_sfu` is accepted by the current provider validator | `apps/api/internal/mediaplane/service.go:33`; `apps/api/internal/mediaplane/service.go:339` | Add `chalk_sfu` throughout authority and generated contracts; do not disguise our provider as Cloudflare. |
| API authenticates the Participant's connection and proxies signaling | `apps/api/internal/httpapi/sfu_signaling.go:677` | Keep browser credentials at the API; extend the provider-aware authorization checks. |
| Current signaling resolves the mutable Space selector | `apps/api/internal/httpapi/sfu_signaling.go:691` | Change own-provider routing to the Episode's frozen binding; never reroute a live connection after a flag flip. |
| Binding freezes provider application, excluding credentials | `apps/api/internal/mediaplane/binding.go:20`; `apps/api/internal/adapters/mediaplaneproviders/binding.go:14` | Extend binding resolution and use it for joins, refresh, signaling and cleanup, not only capture. |
| Separate recording adapter implements the capture protocol | `apps/api/internal/adapters/cloudflare/sfu/capture_plane.go:20` | Live-media parity does not supply recording parity. |

### Every Cloudflare-shaped SDK dependency to preserve or explicitly extend

1. **Provider and bootstrap discrimination.** Access decoding and connection
   replacement require `cloudflare_sfu`; bootstrap contains `connectionId`,
   `stunServer`, optional credentialed `iceServers`. Reuse the same media engine
   for additive `chalk_sfu` grants, updating these checks and native consumers.
   Old SDKs remain on Cloudflare; an unknown provider must not fall through.
   Evidence: `sdks/typescript/client/src/access/grant.ts:170`,
   `sdks/typescript/client/src/connection/production.ts:109`,
   `sdks/typescript/client/src/connection/lifecycle.ts:857`,
   `sdks/typescript/client/src/media/types.ts:8`. React Native also checks the
   provider on replacement/restart and uses `@cloudflare/react-native-webrtc`;
   this WebRTC binding can stay, but Pion interoperability must be proven
   (`sdks/typescript/react-native/src/space-client/create-native-space-client.ts:18`,
   `:128`, `:150`).
2. **Signaling envelope.** Browser requests go to Chalk's `/media/sfu` routes,
   with snake-case outer request fields and camel-case track/response fields;
   browser operations are tracks, tracks/update, tracks/close, renegotiate and
   publications (Cloudflare's upstream push/pull path is tracks/new).
   The transport normalizes `publication_id` to `publicationId`.
   Fresh media credentials are read per request; normal signaling
   has an eight-second HTTP deadline. No trickle-ICE route exists.
   Evidence: `sdks/typescript/client/src/media/transport.ts:7` and `:54`.
3. **Session plus named tracks, not rooms.** Local tracks carry an SDP MID and
   name; remote tracks refer to the publisher's session and name. Publication
   IDs encode that pair, with `chalk_pub_v1.` and legacy reference decoding.
   Preserve opaque connection identity and the API's publication-ID generation.
   Evidence: `sdks/typescript/client/src/media/tracks.ts:11`,
   `sdks/typescript/client/src/media/client.ts:958` and `:1222`.
4. **Offer/answer roles.** Push supplies a browser offer and applies the returned
   description. Pull can supply no SDP and receive a server offer; the browser
   answers through Renegotiate. Every server offer is answered regardless of
   `requiresImmediateRenegotiation`; the SDK is polite and rolls back glare.
   Operations serialize on one PeerConnection, which can both send and receive.
   Return complete SFU ICE candidates in SDP; do not require new socket signaling.
   Evidence: `sdks/typescript/client/src/media/client.ts:937`, `:1246`, `:1368`.
5. **Exact returned identities and partial success.** Successful pulls must
   return `location: remote`, publisher `sessionId`, `trackName` and a unique MID;
   `ontrack` is matched by MID. Mixed batches preserve successful tracks and SDP
   while returning per-track errors, including HTTP-200 partial responses.
   Evidence: `sdks/typescript/client/src/media/remote-track-response.ts:4`,
   `sdks/typescript/client/src/media/client.ts:1251`,
   `apps/api/internal/httpapi/sfu_signaling.go:191`.
6. **Camera RID semantics.** Chrome-like publishers send `h` (2.5 Mbps maximum)
   and `l` (650 kbps maximum), both L1T1; Firefox uses one encoding and rejected
   simulcast offers retry without it. Camera pulls initially request `h`,
   `priorityOrdering: none`, `ridNotAvailable: asciibetical`; `h` sorts before `l`.
   That spelling is wire protocol. It prevents a frozen picture when the desired
   RID is paused. Layer updates must not create SDP or a new track/MID.
   Evidence: `sdks/typescript/client/src/media/client.ts:922`, `:937`, `:1233`,
   `:1329`; `apps/api/internal/adapters/cloudflare/sfu/adapter.go:420`.
7. **Two independent quality loops.** SDK uplink policy may disable a camera
   encoding; viewer policy requests `h`/`l` from tile size, loss and freezes.
   Keep both. Own-SFU TWCC allocation needs one explicit extension: an advertised
   `serverLayerAdaptation: true` bootstrap capability makes preferred RID a
   quality ceiling/goal, not Cloudflare's exact-live-RID promise. Under congestion
   the server may choose lower, without changing the requested ceiling. Default
   absent/false preserves Cloudflare semantics. Test this distinction; never
   silently reinterpret `priorityOrdering: none` for Cloudflare.
   Evidence: `sdks/typescript/client/src/media/camera-uplink.ts:1`,
   `sdks/typescript/client/src/media/viewer-layer.ts:1`,
   `sdks/typescript/client/src/media/client.ts:1233` and `:1297`.
8. **Close is not always session termination.** Preserve force-close without
   SDP, negotiated close, idempotent absent-track cleanup, and receive-only close
   which cannot stop publishing. Screen and screen audio stop together.
   Evidence: `apps/api/internal/adapters/cloudflare/sfu/adapter.go:434`,
   `sdks/typescript/client/src/media/types.ts:64`,
   `sdks/typescript/client/src/media/client.ts:1884`.
9. **Liveness and disappearance.** The API inspects sessions/tracks and reconciles
   missing publications, rather than trusting a cached roster. Preserve active
   versus inactive status and missing-session evidence. Cloudflare's delayed
   session allocation, alias replacement and propagation lag are adapter quirks,
   not delays to emulate. A transient failed pull must not delete a live source.
   Evidence: `apps/api/internal/adapters/cloudflare/sfu/adapter.go:331` and `:393`,
   `apps/api/internal/mediapublications/reconciliation.go:19`.
10. **Recovery, retirement and errors.** Replacement must return a different
    connection ID, fence old callbacks/publications, reset the roster cursor and
    republish only wanted sources. Preserve normalized 404/410 gone, 429 throttled,
    transient 5xx and timeout behavior; map provider codes at the adapter seam.
    The SDK has a conservative 20-second capture-reuse window because Cloudflare
    expires tracks after 30 seconds without RTP. Keep the safety guard even if
    our expiry differs. Evidence: `sdks/typescript/client/src/media/client.ts:72`,
    `:1543`, `:1888`; `sdks/typescript/client/src/media/transport.ts:39`.
11. **Roster and statistics are Chalk contracts.** Keep incarnation/sequence
    ordering, self-publication filtering, receive-stall repulls, bounded retries
    and call-stats uploads through the API. These are not a Cloudflare discovery
    endpoint or a vendor stats endpoint. Evidence:
    `sdks/typescript/client/src/media/types.ts:51`,
    `sdks/typescript/client/src/media/client.ts:1029`, `:1353`, `:1792`,
    `sdks/typescript/client/src/media/call-stats.ts:1`.

The groundwork PRs are [#670](https://github.com/Q9Labs/chalk/pull/670),
[#671](https://github.com/Q9Labs/chalk/pull/671),
[#674](https://github.com/Q9Labs/chalk/pull/674),
[#676](https://github.com/Q9Labs/chalk/pull/676),
[#724](https://github.com/Q9Labs/chalk/pull/724),
[#745](https://github.com/Q9Labs/chalk/pull/745),
[#746](https://github.com/Q9Labs/chalk/pull/746) and
[#761](https://github.com/Q9Labs/chalk/pull/761).
In particular, #724 is off-debt replay, not an in-place ICE-restart implementation;
PR #746 is model evidence, not a production fix.

## Placement and control contract

Put the deployable in **`features/media/sfu/`**, its own Go module, rather than
an apps-level shell: a one-feature deployable belongs with the feature under
[`docs/architecture.md`](../architecture.md). Keep the API adapter at
**apps/api/internal/adapters/chalksfu/** (planned) while that existing seam remains there.
Do not import API `internal` packages across module boundaries. A small public
`protocol` package in the SFU module owns versioned HTTP DTOs; the adapter
translates to/from `mediaplane`. No parallel domain model or database replica.

```text
SDK -- authenticated HTTPS signaling --> API -- private mTLS --> SFU control
 |                                        ^                     |
 +--------- ICE / DTLS-SRTP / RTCP ------------------------------+
                                          |
Sync -- existing private provider bridge -+ -- Postgres authority
```

Control listens on private TCP 8443, using mutual TLS with separately rotated
API-client and SFU-server identities; authorize the expected service identity,
not any certificate signed by the CA. Private networking is not authentication.
The browser never receives a service secret and never calls this listener.
Reuse the managed runtime's certificate delivery conventions, not its private
addresses or credentials (`apps/sync/README.md:236`). Same-region hosting does
not imply a shared VPC: the current application tier is on AWS
(`infrastructure/managed-episode/README.md:4`). Establish a managed WireGuard
overlay between the API host and the DO node; bind control to that overlay
address. Firewall its UDP 51820 listener to configured API-host egress only.
The overlay transports control/telemetry, not public media. M6 must prove routing,
key rotation and recovery across the two clouds. No private route is assumed
to exist merely because both hosts are in Singapore.

The internal `/v1` protocol supports:

| Operation | Required behavior |
| --- | --- |
| Ensure Episode / create or resume session | Scope to Tenant, Episode, Participant and generation; return opaque connection ID and ICE bootstrap. Creation uses an operation ID. Resume validates a live allocation; absent old allocation leads to explicit fresh join. |
| Push / pull tracks | Use port track fields and SDP envelope above. Push answers client offer; pull returns server offer if negotiation is needed. Return per-track success/errors, never fictitious success. |
| Renegotiate | Apply browser answer to the pending server offer; one serialized negotiation per session, with a bounded deadline. |
| Update tracks | Update an existing remote subscription's ceiling/fallback in place; no SDP. |
| Close / inspect | Forced or negotiated track close; idempotent teardown; inspect existence, direction, MID, track name and active state. |
| Grant / revoke source; remove Participant; end Episode | Revision-fenced controls distinct from SDP. Revoke prevents later stale re-admission even if no publication existed. |
| Usage | Bounded process counters for operational estimates; never fabricate a durable billing total after restart. |

Attach API-verified scope, binding identity, node incarnation, connection generation,
operation ID and, for grant/revoke, control revision. These are internal extensions:
today's `TracksRequest.SpaceID/EpisodeID` are diagnostic labels, not authorization
(`apps/api/internal/mediaplane/signaling.go:35`). Resolve scope from authenticated
authority at the API, never from caller-supplied track names. The SFU verifies
that every referenced publisher and subscriber belongs to the same Tenant/Episode.

Bound requests, tracks per batch, sessions, subscriptions and pending SDP. Keep
one owner for session negotiation and one ordered source-control fence; packet
loops read immutable routing snapshots and never hold a global lock on network
I/O. Mutations use operation ID + body digest: identical replay returns the prior
result, conflicting reuse fails. Bound replay storage by live-session lifetime
and node capacity; never evict a live revoke watermark to admit more work.

## Media path

- Negotiate Opus, VP8 and compatible H.264 passthrough, including RTX payload
  associations where supported. Do not advertise codecs we cannot forward or
  translate safely. Single-encoding browsers must work. One screen-video stream
  and optional screen audio initially; no server transcoding or screen simulcast.
- Demux publisher RTP by SSRC/MID/RID. Receive both camera RIDs, but forward one
  per subscription. Track layer activity; a paused layer is not publication death.
- Switching waits for a decodable keyframe, throttles upstream PLI/FIR, and
  preserves subscriber-facing track identity. Translate sequence numbers,
  timestamps and codec picture identifiers across switches; rewrite negotiated
  header-extension IDs and SSRC mappings. Merely copying RTP between tracks is
  not enough. Keep each subscriber's translation and retransmission history.
- Generate ingress TWCC feedback to help the publisher's browser control uplink.
  Assign fresh transport-wide sequence numbers on each subscriber transport;
  consume its feedback in GCC and pace output. Do not forward a publisher's
  transport-wide sequence space as the subscriber's. Budget audio first, then
  screen, then cameras within requested ceilings. Drop quality quickly, raise
  slowly with hysteresis; if even the lowest camera layer does not fit, pause
  video while retaining audio. RID absence fallback is separate from congestion.
- Use Pion NACK generation on ingress and NACK response on egress with negotiated
  RTX SSRC/PT mappings; verify real retransmissions rather than assuming default
  interceptor registration supplies an entire recovery policy. Read RTCP on all
  senders. Cap packet age, bytes and retransmission rate; include repair traffic
  in the congestion budget. Slow subscribers cannot block publisher readers.
- Forward negotiated RFC 6464 audio-level metadata when present, without decoding
  or retaining audio. The current media SDK has no audio-level signaling call;
  participant speaking state comes through Sync (`sdks/typescript/client/src/sync/v1-client.ts:1137`).
  Do not add a competing SFU-owned presence/active-speaker authority in v1.

## Reconnect and authority

Postgres owns durable admission, permissions, media-control revisions and operation
intents. The SFU owns only actual allocations and packet liveness. Losing a Sync
socket is presence loss, not durable Leave (`apps/sync/README.md:3` and `:120`).

Use the decided rules in the media-control model at commit
[`026902eea330b3b58d9e739bd65860423c9e356c`](https://github.com/Q9Labs/chalk/tree/026902eea330b3b58d9e739bd65860423c9e356c/tools/formal/media-control),
especially its README, `Sfu.tla` and
[results/summary.md](https://github.com/Q9Labs/chalk/blob/026902eea330b3b58d9e739bd65860423c9e356c/tools/formal/media-control/results/summary.md):

1. Off stops local capture immediately. It cannot fail as a user intent; retain
   the owed off across timeouts/reconnects until Sync accepts it. Never stop a
   different device's publication while repaying it.
2. On is authorized by Sync. Pending permission/publication is not visible-on;
   recovering a stale on snapshot must never restart a locally muted source.
3. Recover grants and newer moderation stops, not just observed publications.
   A missing publication is not itself a host stop. Preserve #745: a proven
   short drop under 60 seconds can retain consent; long/unproven drops require
   a new user on, unless the user already made a fresh action during the drop.
   Without the negotiated off-reason extension, retain fail-closed legacy behavior.
4. Fence stale generation/revision callbacks. Old publishes, delayed enables,
   old closes and old node responses cannot affect newer intent or allocations.

Current executable references: `sdks/typescript/client/src/space-client/media-controller.ts:43`, `:795`, `:1325` under
`sdks/typescript/client/src/space-client/`; `apps/sync/README.md:330`.
The bounded model is not an implementation proof and explicitly leaves actual
command ordering and the off-with-no-publication path unverified. Test those paths.

**Distributed revoke is not atomic.** The model's `own` variant assumes
`AtomicRevoke=TRUE` and infallible close. A separate SFU cannot atomically change
Postgres through an HTTP call. Keep durable operation intents, retry cleanup and
make revoke atomic only inside the SFU's routing state. Retain a per-source
revision tombstone even without a track; remove routing before acknowledging
revoke. A newer authorized grant alone can clear it. Preserve distinct scopes:
a device's off/old-session close targets only its owned allocation; a host stop
fences the Participant/source across allocations. Neither may let a late close
kill another device's newer publication. The current provider
executor's resume is a no-op and its cleanup is track-based
(`apps/api/internal/providerbridge/sfu_executor.go:95` and `:153`); M3 must add
source-level grant/revoke dispatch, including the no-track case.

Use short-lived forwarding leases (initial proposal: 15-second TTL, refresh every
five seconds in bounded batches) backed by current durable authorization. Lost
control connectivity then stops forwarding by expiry rather than preserving a
muted orphan indefinitely. Do not extend from RTP receipt or SDK claims. Check
expiry on the forwarding path, not solely a delayed GC ticker. Lease refresh,
grant and revoke share the same revision order; a stale refresh cannot resurrect
a revoked source. Transport loss therefore has a bounded mute-enforcement window,
not a zero-window atomicity guarantee. Recheck the model with failing close,
orphan cleanup and delayed lease/revoke delivery before enabling the flag.

**ICE restart:** support a client offer with new ICE credentials on an existing
session through AddTracks, returning an answer without duplicating publications.
There is no SDK `restartIce()`/`iceRestart` call in this baseline; current recovery
replaces the connection (`sdks/typescript/client/src/media/client.ts:1543`). Add an own-provider-capability
gated restart attempt in the shared SDK, serialized with other SDP, with one
eight-second budget before using existing replacement. Restart preserves consent
and off debt; it does not imply media on. Failed restart or missing session gets
a fresh bootstrap, generation and PeerConnection. Never reuse a DTLS association
across a node incarnation change. Prove Wi-Fi/mobile-style address changes and
TURN/TLS-only recovery independently of the Sync reconnect tests.

**Node loss:** all sessions, packets and retransmission caches disappear. A new
boot uses a new incarnation; reject old handles with normalized gone responses.
Clients replace sessions, republish authorized wanted sources and re-pull from
the API's new roster. Reconcile dead observations through existing API/Sync paths;
do not replay cached on states as permission. No media/session state is restored
from disk. Postgres unavailability prevents new admissions and lease extension.

## TURN, network and deployment

V1 reuses **current Cloudflare TURN on TCP/TLS 443**, preserving the accountable-
owner `AllowRelay` policy, short-lived credential delivery, bounded mint timeout
and STUN-only fallback (`apps/api/internal/mediaplane/service.go:60`;
`apps/api/internal/adapters/cloudflare/sfu/turn.go:1`). Run the relay-only proof
against our SFU: being compatible with Cloudflare SFU does not prove an arbitrary
destination. If it fails, coturn is a rollout blocker, not a silent fallback.

Cloudflare TURN is no longer free of separate relay billing when the SFU is
outside Cloudflare: it charges edge-to-client traffic at $0.05/GB after the shared
allowance ([TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/)).
Self-hosted coturn can follow later if cost or path quality justifies it. Use a
separate relay listener/address for TLS 443, short-lived authenticated credentials,
quotas and private-destination restrictions; do not open an unauthenticated relay.

Use a direct Droplet public media address, not an HTTP CDN/proxy. Recommended
Pion UDP mux: **UDP 50000**, one public candidate shared across sessions. If M1
uses a per-session range instead, reserve **UDP 50000–50100** and test exhaustion;
choose one mode explicitly before staging, not both accidentally.

| Firewall direction | Allow |
| --- | --- |
| Public inbound | UDP 50000 (or the configured range); no public SFU HTTP/debug endpoint. |
| Control-overlay inbound | UDP 51820 only from configured API-host egress; no unrestricted management listener. |
| Private inbound | TCP 8443 only from API workload identities/networks; readiness and metrics only from private operators/collectors. |
| Administration | SSH only from the managed operator network. |
| Outbound | UDP media/replies to clients and TURN allocations; DNS, time sync and HTTPS/OTLP to configured services. Allow outbound ephemeral destinations, not only inbound media ports. |
| Client access to existing TURN | Outbound UDP/TCP 3478 and TCP 80/5349/443 as available; strict-network proof permits only TCP 443. |

Restrict signaled ICE candidates to intended public media addresses; never expose
VPC candidates to clients or let untrusted SDP turn the SFU into a private-network
probe. Validate selected-peer reachability with ICE consent, anti-amplification
limits and bounded unauthenticated handshakes. Apply host and cloud firewalls.

## Hosting and budget

Public list prices checked **5 November 2026**, USD before tax. DigitalOcean's
[availability matrix](https://docs.digitalocean.com/platform/regional-availability/)
lists Basic and CPU-Optimized in Singapore `sgp1`; individual creation-time stock
still needs checking. Use Regular CPUs for these estimates, not Premium pricing.

| Environment | Droplet | CPU / RAM / disk | Included monthly outbound | Monthly compute |
| --- | --- | --- | --- | --- |
| Staging | Basic Regular (`s-2vcpu-4gb`) | 2 shared vCPU / 4 GiB / 80 GiB | 4,000 GiB | **$24** |
| Production v1 | CPU-Optimized Regular (`c-4`) | 4 dedicated vCPU / 8 GiB / 50 GiB | 5,000 GiB | **$84** |

Source: [Droplet pricing](https://www.digitalocean.com/pricing/droplets).
No load balancer, managed disk or media backup is needed for this disposable
node. Existing API/Sync/Postgres and observability bills are excluded. Inbound
transfer is free; excess outbound is $0.01/GiB, with allowances pooled across the
team, not reserved to this SFU ([bandwidth billing](https://docs.digitalocean.com/platform/billing/bandwidth/)).
Do not count another workload's unused allowance as guaranteed SFU capacity.

### Capacity hypothesis, not a benchmark

The durable admission ceiling is **500**, not a measured SFU capacity
(`apps/api/internal/episodes/service.go:75`). The SDK subscribes to all other
Participants' publications, not just visible video tiles (`sdks/typescript/client/src/media/client.ts:1792`).
Camera encoding caps are 2.5 + 0.65 Mbps (`sdks/typescript/client/src/media/client.ts:927`). Therefore full
mesh subscriptions grow as `N * (N - 1)`, even though publishers upload once.

For planning use a four-person call, camera plus microphone per Participant;
eight-person and screen variants must also pass. This is a synthetic sizing
fixture, **not observed customer traffic**. Budget audio at 50 kbps and add 20%
for headers, RTCP and repair. Let `H=2.5`, `L=0.65`, `A=0.05` Mbps:

- All-high egress: `1.2 * N * (N - 1) * (H + A)` Mbps. This is the conservative
  default because every new camera pull initially requests high.
- Mixed egress, one high remote camera and the rest low per viewer:
  `1.2 * N * (H + (N - 2) * L + (N - 1) * A)` Mbps.
- Ingress with both RIDs: `1.2 * N * (H + L + A)` Mbps.
- Outbound RTP streams: `2 * N * (N - 1)`; ingress encodings: `3 * N`.
  One 2 Mbps screen plus 50 kbps screen audio adds `N - 1` subscriptions of
  each kind and `1.2 * (N - 1) * 2.05` Mbps egress. This screen rate is an
  assumption, not an SDK-enforced cap; admission uses configured ceilings.

| Participants | Outbound streams | Ingress Mbps | All-high / mixed egress Mbps | All-high / mixed GiB per call-hour |
| --- | --- | --- | --- | --- |
| 4 | 24 | 15.36 | 36.72 / 18.96 | 15.39 / 7.95 |
| 8 | 112 | 30.72 | 171.36 / 64.80 | 71.82 / 27.16 |

Start with an **unmeasured engineering target of 100 outbound RTP streams per
dedicated vCPU** and reserve 50%: at most 200 on the production node. Also cap
planned all-high egress at 250 Mbps and stop new admissions when sustained CPU
exceeds 60%, queue delay exceeds 50 ms or retransmission memory is exhausted.
The tightest budget wins. This permits roughly one eight-person call, or six
four-person calls without screen sharing, not a throughput guarantee. Staging
admits one four-person test call; shared CPUs are not a production benchmark.
Validate packet rate, encryption, GC and TURN paths on the actual `c-4` in M6;
lower admission limits if it misses the target. Never infer capacity from vCPU
count alone or use codec bitrate caps as guaranteed actual traffic.

For decimal Mbps, `GiB/hour = Mbps * 10^6 * 3600 / (8 * 2^30)`.
At 10 four-person staging call-hours/month, direct egress is about 154 GiB and
cost stays $24. At 500 production call-hours, all-high costs about 7,695 GiB:
compute plus excess transfer is **about $111/month**; mixed quality is about
3,973 GiB and stays **$84/month**. These are call-hours, not participant-hours.
The 5,000 GiB allowance covers about 325 all-high or 629 mixed four-person hours.

Add relay cost separately: if 10% of the all-high traffic is delivered via
Cloudflare TURN, that is about 826 decimal GB/month, up to **$41/month** before
any remaining shared Cloudflare free allowance. DO still charges its SFU egress
to the relay. At that planning volume production is about **$152/month including
relay**, not a flat $84. Real demand and shared allowance usage are unknown;
replace these scenarios with existing call-stats/usage evidence before expansion.

## State, scaling and operations

SFU memory contains sessions, layer activity, routing snapshots, bounded packet
caches, source revision tombstones and leases. No Postgres client in the SFU;
the API authorizes control and renewals. Packet caches are transient and never
written to disk. Graceful drain rejects new Episodes, allows existing calls to
finish within an operator deadline, then triggers ordinary replacement. Readiness
includes certificate/config validity, media listener availability and drain state;
health endpoints disclose no identifiers.

For multi-node, keep one Episode on one node first. Extend its durable binding
with node assignment and boot incarnation; API routing uses that assignment for
every operation, including cleanup. Admission can choose among healthy nodes;
never round-robin session control. On loss, explicitly replace allocations on
a new node rather than pretending PeerConnections migrated. Only later consider
cascading within an Episode; this does not require Redis as correctness authority.

Follow [observability](../observability.md): carry `traceparent`, allowlisted
`session.id` baggage and existing journey/operation context from API to SFU and
through deferred cleanup. A provider session ID is not the device's `session.id`.
Export structured OTLP logs/spans using private runtime configuration.

- Counters/gauges: active sessions/publications/subscriptions, requested/effective
  RID, source lease expiry/revoke, packet/byte rates, repair hit/miss, PLI rate,
  TWCC feedback age, estimated bitrate, pacer drops/queue delay, CPU/GC and memory.
- Histograms: control latency by operation/outcome, first RTP, ICE/replacement
  recovery time and time from revoke receipt to routing removal.
- Metrics labels are bounded provider/codec/kind/RID/outcome; no Tenant, Episode,
  Participant, publication, IP or session IDs as metric labels. Correlated logs
  may carry existing authorized domain IDs and hashed Participant identity.
- No SDP, ICE candidates, credentials, device labels, raw errors, packet dumps or
  media payloads in telemetry; disable packet-dump interceptors and core dumps.
  Sample success, retain bounded failure reasons, and cap log/export queues.
- Keep the SDK's existing call-stats path for client-observed RTT/loss/freeze and
  the listener-heal evidence. A server's bytes-sent counter does not prove audio
  rendered. Add a bounded provider dimension for cohort comparison.

Update the journey ledger and executable observability proof when lifecycle
boundaries change. Ordinary ICE diagnostics need no new durable journey event;
durable grant/revoke outcomes must retain the existing operation correlation.
SFU-local telemetry cannot replace durable Postgres lifecycle evidence.

## Security and rollout

DTLS-SRTP terminates at the SFU; this is transport encryption, not E2EE. Authenticate
control with mTLS, retain API Participant authorization, check cross-session scope,
and fence node/generation/source revisions. Apply per-Tenant/Participant API
limits and per-service/session/packet limits at the SFU. Reject oversized SDP,
excess tracks, unsupported codecs and unauthenticated control before allocating
unbounded state. Test cross-Tenant pulls and forged/stale identifiers.

Ship disabled by default. A server-side Tenant default with Space override picks
the provider only when creating an Episode; persist its provider/application
binding in the same authority transaction. New `chalk_sfu` provider and bootstrap
capabilities are additive contract changes: run `pnpm run regen` and
`pnpm run check:generated`; verify the preceding server release still runs with
the expanded schema. Deploy accepting servers and compatible SDKs before canary
selection. Do not expose own-provider Spaces to unsupported SDK versions.

Canary only internal, accountable-owner Spaces with at most eight Participants
and no capture dependencies. Compare matched network/codec/call-shape cohorts
against Cloudflare, including TCP-443-only callers. Gate on successful join,
audible/rendered media, no privacy regressions, recovery and resource budgets,
not just successful HTTP responses. See M6/M7 for concrete acceptance checks.

**Rollback:** flip the selection flag back to Cloudflare for new Episodes;
keep the own-SFU adapter and node running for pinned live Episodes. To recover
an unhealthy active Episode, perform an explicit coordinated rejoin/replacement
through the authority path; changing the selector alone cannot migrate media.
Do not remove the provider or credentials until all bound Episodes and cleanup
intents have drained. Rollback needs no destructive schema reversal.
