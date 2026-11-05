# Chalk SFU v1

Status: implementation proposal. Scope: a second media provider, not a new call
protocol. Singapore (`sgp1`) is the deployment region, on small shared-CPU
Droplets sized from the packet and memory budgets below. This document does not
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
Fork a Pion module only on profile evidence; see
[Pion dependency and fork policy](#pion-dependency-and-fork-policy).

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
- Adaptive quality: send each viewer the lowest layer that looks right at their
  tile size and network, to lower egress cost and give a picture that follows
  the viewer's network and latency. See [Adaptive quality](#adaptive-quality).
- A small machine: a Basic shared-CPU Droplet in production ($18 a month) and in
  staging ($6 a month), kept within measured packet, memory and steal budgets.
  See [Hosting and budget](#hosting-and-budget).
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

## Pion dependency and fork policy

Start on **pinned upstream Pion modules** (`webrtc`, `interceptor`, `rtp`, `srtp`,
`ice`, `transport` and what they pull in). M1 reviews and pins the versions, and
later updates are deliberate, never floating. A fork is a response to a profile,
not a plan.

Fork a module only when a CPU or heap profile from the M6 harness (or a later
production profile) shows a hotspot in that module and upstream cannot fix it in
time: a fix is open and unmerged, maintainers have declined it, or the change is
Linux-only and they will not take it.

- **Where and how.** Fork into the Q9Labs GitHub organization and wire the fork
  into `features/media/sfu/go.mod` with a `replace` directive pinned to a commit.
  Only the SFU module uses it.
- **Keep it small.** One patch per hotspot, rebased onto each upstream release we
  adopt, and dropped when upstream ships an equivalent fix. Retain the upstream
  license and headers.
- **Send fixes upstream** whenever they could be accepted, to shrink what we carry.
- **Record every patch** in **features/media/sfu/FORK_PATCHES.md** (planned): the
  profile that justified it (function, share of CPU or allocation, SKU,
  workload), the change, the before and after measurements, the upstream pull
  request and the condition for removing it. A patch without a recorded profile
  does not merge.

Likely candidates, stated as hypotheses to check against the pinned versions, not
as plans:

- **Batched UDP sends** (`sendmmsg`, or UDP GSO where segments share a size and
  destination) in `pion/transport` and the UDP mux in `pion/ice`, to replace one
  system call per packet. An SFU fans out different packets to different
  subscribers, so `sendmmsg` is likelier to help than GSO.
- **Per-packet allocations** in the RTP and SRTP paths (`pion/rtp`, `pion/srtp`),
  if the profile shows packet buffers allocated on each packet.

Do not adopt LiveKit's separate Pion fork to get either change.

## Verified baseline and compatibility inventory

References below describe commit `570a3d32a996fd273e75363f9ccd08421a2197ff`.
Paths and line numbers are evidence for current behavior, not proposed APIs.
The SDK is now under `sdks/typescript/`, not `packages/`.

| Current seam                                                                                                | Evidence (`file:line`)                                                                                       | V1 obligation                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Lifecycle port: EnsureEpisode, CreateJoin, RemoveParticipant, EndEpisode, EpisodeUsage; optional ResumeJoin | `apps/api/internal/mediaplane/service.go:36`                                                                 | Implement lifecycle as well as track signaling; retries cannot duplicate joins.                                 |
| AddTracks, Renegotiate, InspectSession, UpdateTracks, CloseTracks are separate optional ports               | `apps/api/internal/mediaplane/signaling.go:101`                                                              | Implement all five. A basic push/pull example alone is insufficient.                                            |
| Only `cloudflare_sfu` is accepted by the current provider validator                                         | `apps/api/internal/mediaplane/service.go:33`; `apps/api/internal/mediaplane/service.go:339`                  | Add `chalk_sfu` throughout authority and generated contracts; do not disguise our provider as Cloudflare.       |
| API authenticates the Participant's connection and proxies signaling                                        | `apps/api/internal/httpapi/sfu_signaling.go:677`                                                             | Keep browser credentials at the API; extend the provider-aware authorization checks.                            |
| Current signaling resolves the mutable Space selector                                                       | `apps/api/internal/httpapi/sfu_signaling.go:691`                                                             | Change own-provider routing to the Episode's frozen binding; never reroute a live connection after a flag flip. |
| Binding freezes provider application, excluding credentials                                                 | `apps/api/internal/mediaplane/binding.go:20`; `apps/api/internal/adapters/mediaplaneproviders/binding.go:14` | Extend binding resolution and use it for joins, refresh, signaling and cleanup, not only capture.               |
| Separate recording adapter implements the capture protocol                                                  | `apps/api/internal/adapters/cloudflare/sfu/capture_plane.go:20`                                              | Live-media parity does not supply recording parity.                                                             |

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
   RID is paused. (For the own provider the `h` is a ceiling and the server starts
   a new pull on `l`; see [Adaptive quality](#adaptive-quality).) Layer updates must not create SDP or a new track/MID.
   Evidence: `sdks/typescript/client/src/media/client.ts:922`, `:937`, `:1233`,
   `:1329`; `apps/api/internal/adapters/cloudflare/sfu/adapter.go:420`.
7. **Two independent quality loops.** SDK uplink policy may disable a camera
   encoding; viewer policy requests `h`/`l` from tile size, loss and freezes.
   Keep both. Own-SFU TWCC allocation needs one explicit extension: an advertised
   `serverLayerAdaptation: true` bootstrap capability makes preferred RID a
   quality ceiling/goal, not Cloudflare's exact-live-RID promise. At pull start and
   under congestion the server may choose lower, without changing the requested
   ceiling. Default
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
SDK -- authenticated HTTPS signaling --> API -- mTLS over public TCP 8443 --> SFU control
 |                                        ^                     |
 +--------- ICE / DTLS-SRTP / RTCP ------------------------------+
                                          |
Sync -- existing private provider bridge -+ -- Postgres authority
```

Control listens on public TCP 8443, using mutual TLS with separately rotated
API-client and SFU-server identities; authorize the expected service identity,
not any certificate signed by the CA. Private networking is not authentication.
The browser never receives a service secret and never calls this listener.
Reuse the managed runtime's certificate delivery conventions, not its private
addresses or credentials (`apps/sync/README.md:236`). Same-region hosting does
not imply a shared VPC: the current application tier is one AWS node
(`infrastructure/managed-episode/README.md:4`). Control therefore crosses the
public internet with no tunnel or overlay. Mutual TLS is the authentication;
the DigitalOcean cloud firewall additionally limits TCP 8443 to the API host's
fixed Elastic IP, the same address the recorder worker firewalls already allow
(`infrastructure/managed-episode/README.md:228`). M6 must prove certificate
rotation and that every other source address is refused.

The internal `/v1` protocol supports:

| Operation                                              | Required behavior                                                                                                                                                                                                           |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ensure Episode / create or resume session              | Scope to Tenant, Episode, Participant and generation; return opaque connection ID and ICE bootstrap. Creation uses an operation ID. Resume validates a live allocation; absent old allocation leads to explicit fresh join. |
| Push / pull tracks                                     | Use port track fields and SDP envelope above. Push answers client offer; pull returns server offer if negotiation is needed. Return per-track success/errors, never fictitious success.                                     |
| Renegotiate                                            | Apply browser answer to the pending server offer; one serialized negotiation per session, with a bounded deadline.                                                                                                          |
| Update tracks                                          | Update an existing remote subscription's ceiling/fallback in place; no SDP.                                                                                                                                                 |
| Close / inspect                                        | Forced or negotiated track close; idempotent teardown; inspect existence, direction, MID, track name and active state.                                                                                                      |
| Grant / revoke source; remove Participant; end Episode | Revision-fenced controls distinct from SDP. Revoke prevents later stale re-admission even if no publication existed.                                                                                                        |
| Usage                                                  | Bounded process counters for operational estimates; never fabricate a durable billing total after restart.                                                                                                                  |

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
result, conflicting reuse fails. Session creation gets this in M1; the other
mutations get it in M2, where the API adapter starts retrying them. Bound replay storage by live-session lifetime
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
  not enough. Keep each subscriber's translation state and a small outgoing
  sequence map; keep the packet bytes once per ingress stream, shared by all
  subscribers (see [Memory budget](#memory-budget)).
- Generate ingress TWCC feedback to help the publisher's browser control uplink.
  Assign fresh transport-wide sequence numbers on each subscriber transport;
  consume its feedback in GCC and pace output. Do not forward a publisher's
  transport-wide sequence space as the subscriber's. Budget audio first, then
  screen, then cameras within requested ceilings. Drop quality quickly, raise
  slowly with hysteresis; if even the lowest camera layer does not fit, pause
  video while retaining audio. RID absence fallback is separate from congestion.
  [Adaptive quality](#adaptive-quality) defines the allocator's goals.
- Use Pion NACK generation on ingress and NACK response on egress with negotiated
  RTX SSRC/PT mappings; verify real retransmissions rather than assuming default
  interceptor registration supplies an entire recovery policy. Read RTCP on all
  senders. Cap packet age at one second and bytes per stream at the
  [memory budget](#memory-budget); cap retransmission rate; include repair traffic
  in the congestion budget. Slow subscribers cannot block publisher readers.
- Forward negotiated RFC 6464 audio-level metadata when present, without decoding
  or retaining audio. The current media SDK has no audio-level signaling call;
  participant speaking state comes through Sync (`sdks/typescript/client/src/sync/v1-client.ts:1137`).
  Do not add a competing SFU-owned presence/active-speaker authority in v1.

## Adaptive quality

Two goals drive this section. First, **lower egress**: egress above the included
allowance is the largest variable cost (see [Cost scenarios](#cost-scenarios)), and
packets forwarded are the main CPU cost on a small node. Second, **a picture that
follows each viewer's network**: a viewer on a weak link gets a lower layer
before the link queues and freezes, which keeps latency low. One mechanism serves
both: send each viewer the lowest layer that looks right at their tile size and
bandwidth.

Cloudflare behavior stays unchanged. Items that need the own provider sit behind
its `serverLayerAdaptation` capability or a sibling capability, absent for
Cloudflare. Only item 3 is provider-neutral.

1. **Per-subscriber bandwidth estimate picks layers (M5).** Each subscriber
   transport has its own TWCC-based estimate. The allocator spends it on audio,
   then screen, then cameras within requested ceilings, drops fast and raises
   slowly (see Media path).
2. **New own-provider pulls start on the low layer (M5).** A new pull has no
   estimate yet, so today's `h`-first sends 2.5 Mbps unprobed into a link of
   unknown size, wastes egress on tiles that turn out small, and is the likeliest
   moment for a queue and a freeze. The allocator starts on the lowest layer the
   ceiling allows and climbs to the next layer once the estimate and its feedback
   age support it. The SDK still requests `h` as a ceiling. The cost is a picture
   that sharpens over a few seconds; M5 measures that time and bounds it.
   Cloudflare pulls stay `h`-first.
3. **Subscribe to video only for visible tiles (M8).** Today the SDK pulls every
   remote publication, visible or not. The viewer policy already measures tile
   size, but only per received track (`setVideoRenderSize(track, size)`), so it
   cannot decide whether to pull video not yet received. M8 adds a signal keyed by
   publication: `setVideoTileVisibility(publicationId, {width, height} | null)`,
   where `null` means hidden. It is local to the SDK and sends nothing to the
   server. Until the UI reports, a publication is **unknown**: the SDK waits up to 250 ms for
   the first report, then pulls an unknown tile as today (Cloudflare `h`-first, own provider low-first), so a UI that never calls
   it keeps today's behavior and M8 is opt-in per UI. A hidden report pulls no
   video. Once the track exists, `setVideoRenderSize` still feeds the layer
   choice. The SDK pulls a remote camera or screen only while its tile is on
   screen, closes the pull after a debounce when it leaves, and always keeps audio. This needs no SFU feature (it uses the
   existing pull and close calls), so it **ships independently, applies to
   Cloudflare today and cuts Cloudflare egress now.** A viewer who scrolls a tile
   back pays a re-pull; the debounce and an early pull of the next page bound
   that. On the own provider the SDK pauses and resumes a subscription in place
   without SDP once M4's pause state and the capability exist (M5 wires it).
4. **Dynacast (M9).** The publisher stops encoding a camera layer that no
   subscriber has requested. Demand per source is the highest requested ceiling
   across its subscribers (not the congestion-reduced effective layer, which keeps
   headroom for recovery). The SFU returns demand in its lease-refresh and pull/update responses, the API relays it to the
   publisher over the existing source-control path. Demand is information, not a
   command: the SDK owns its encodings and combines three inputs. A layer is
   enabled when it is demanded **and** the uplink policy
   (`CameraUplinkPolicy`) allows it, with a **floor**: if that leaves nothing
   enabled, the SDK enables the cheapest demanded layer anyway, and when nobody
   demands the camera it keeps `l` on, so at least one layer is always enabled
   and a first pull never waits for an encoder start. So demand `{l}` with a
   1 Mbps uplink keeps `l` on (the policy would otherwise disable it), demand `{h}`
   with a low uplink leaves `h` on and `l` off, and demand `{h, l}` follows the
   uplink policy alone. Disabling waits a hold time after the last request;
   enabling is urgent, and the SFU keeps forwarding the remaining layer until the
   new one has a keyframe. This saves
   publisher uplink and ingress packets, and it exists only behind an own-provider
   capability.
5. **Audio-only fallback under congestion (M5).** If the estimate cannot carry
   the lowest camera layer after audio and screen, pause that viewer's video and
   keep audio at its reserved budget. Resume video only after the estimate has held
   above the lowest layer's rate for a hysteresis period. The SDK shows a "video
   paused for network" state, distinct from frozen video, so a viewer is not left
   guessing. The SDK learns of a server pause through a **subscription-state
   read**, because the signaling path is request/response and has no server push.
   The SFU's inspect result carries, per subscription, a state (`active` or
   `paused`), a reason (`congestion`, `viewer` or `source_inactive`) and a
   revision (M4 defines it; M5 exposes it through the API and SDK transport
   behind a `subscriptionState` capability). When the receive-stall detector
   (`receive-stall.ts`) would call a track stalled, an own-provider session first
   reads that state: a `paused` track is shown as paused, not repulled, and is
   re-read every five seconds until RTP advances or the state is `active`; a
   higher revision wins over a late response. Without the capability the stall
   path is unchanged. The SDK's own pauses are known locally and suppress the
   stall check the same way.
6. **A third, lower camera layer (decision in M4).** Today the camera has `h`
   (2.5 Mbps) and `l` (0.65 Mbps). A third layer of about 0.15 Mbps (for example
   320×180) would serve small tiles and weak links. As an upper bound, serving the
   three small tiles of an eight-person adaptive call at 0.15 Mbps instead of 0.65
   cuts egress from 46.08 to 31.68 Mbps (31%). It costs the publisher one more
   encoding (its CPU is unmeasured) and 0.15 Mbps more uplink. M4 measures
   publisher encode CPU and picture quality at that size, and decides to add it
   only if the egress gain and the weak-link benefit outweigh the encode cost.
   Adding it would be own-provider only and capability-gated, because the camera
   RID spelling is wire protocol.

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

| Firewall direction             | Allow                                                                                                                                                                         |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public inbound                 | UDP 50000 (or the configured range); no public SFU HTTP/debug endpoint.                                                                                                       |
| Control inbound                | TCP 8443 only from the API host's Elastic IP, with mutual TLS; readiness and metrics only from configured operators/collectors. No unrestricted management listener.          |
| Administration                 | SSH only from the managed operator network.                                                                                                                                   |
| Outbound                       | UDP media/replies to clients and TURN allocations; DNS, time sync and HTTPS/OTLP to configured services. Allow outbound ephemeral destinations, not only inbound media ports. |
| Client access to existing TURN | Outbound UDP/TCP 3478 and TCP 80/5349/443 as available; strict-network proof permits only TCP 443.                                                                            |

Restrict signaled ICE candidates to intended public media addresses; never expose
VPC candidates to clients or let untrusted SDP turn the SFU into a private-network
probe. Validate selected-peer reachability with ICE consent, anti-amplification
limits and bounded unauthenticated handshakes. Apply host and cloud firewalls.

## Hosting and budget

The goal is the smallest machine that meets measured budgets. Because the SFU
forwards packets and never transcodes, it needs far less CPU than a general media
server, and the design below sizes it from packet rate and memory, not from a
vendor's "media server" tier. Moving up a size is cheap (see
[Resizing](#resizing)), so v1 starts small and grows on evidence.

Public list prices checked **5 November 2026**, USD before tax, Regular CPUs.
DigitalOcean's [availability matrix](https://docs.digitalocean.com/platform/regional-availability/)
lists Basic and CPU-Optimized in Singapore `sgp1`; creation-time stock was not
checked and still needs a check when M6 creates the Droplets.

| Environment   | Droplet                       | CPU / RAM / disk               | Included monthly outbound | Monthly compute |
| ------------- | ----------------------------- | ------------------------------ | ------------------------- | --------------- |
| Staging       | Basic Regular (`s-1vcpu-1gb`) | 1 shared vCPU / 1 GiB / 25 GiB | 1,000 GiB                 | **$6**          |
| Production v1 | Basic Regular (`s-2vcpu-2gb`) | 2 shared vCPU / 2 GiB / 60 GiB | 3,000 GiB                 | **$18**         |

Source: [Droplet pricing](https://www.digitalocean.com/pricing/droplets). Both
environments together cost $24 a month. No load balancer, managed disk or media backup is needed for this
disposable node. Existing API/Sync/Postgres and observability bills are excluded.
Inbound transfer is free; excess outbound is $0.01/GiB, with allowances pooled
across the team, not reserved to this SFU ([bandwidth billing](https://docs.digitalocean.com/platform/billing/bandwidth/)).
Do not count another workload's unused allowance as guaranteed SFU capacity.

### Why these sizes

Production has two vCPUs because forwarding runs next to the Go garbage
collector and the kernel's UDP and encryption work. On one shared vCPU all of
that queues behind a single core that the host can take away. `s-2vcpu-2gb` is
the smallest two-vCPU Basic size. Memory is not what limits it (see the
[memory budget](#memory-budget)); CPU is.
Staging runs the service and one four-person test call or one eight-person
call held to its packet ceiling. One vCPU and 1 GiB are enough for that, and the memory budget
below leaves about half of the 1 GiB free.

### Packet-rate math (hypotheses, replaced by M6 measurements)

CPU cost follows packets per second, not bits per second, because every packet
costs one decrypt or encrypt, one system call and some scheduling. Use
1,200-byte RTP payloads and the camera caps from the SDK (2.5 and 0.65 Mbps;
`sdks/typescript/client/src/media/client.ts:927`). Today's SDK subscribes to all
other Participants' publications, not only visible video tiles
(`sdks/typescript/client/src/media/client.ts:1792`), so subscriptions grow as
`N(N-1)` even though each publisher uploads once.

| Stream             | Rate      | Packets/s | Basis                                             |
| ------------------ | --------- | --------- | ------------------------------------------------- |
| Camera, high (`h`) | 2.5 Mbps  | 250       | 2.5 Mbps / 8 / 1,200 B is about 260               |
| Camera, low (`l`)  | 0.65 Mbps | 70        | 0.65 Mbps / 8 / 1,200 B is about 68               |
| Microphone         | 50 kbps   | 50        | Opus 20 ms frames: set by frame time, not bitrate |
| Screen video       | 2 Mbps    | 210       | assumed rate, not an SDK cap                      |

For a call of `N` Participants, each with camera and microphone, three
subscription profiles apply. In each, every viewer gets every remote microphone.

- **All-high:** every remote camera at `h`. This is what today's `h`-first pull
  does, and it is the worst case.
- **Mixed:** one remote camera at `h`, the others at `l`.
- **Adaptive:** one remote camera at `h` (speaker or pinned tile), at most three
  others at `l`, and the remaining cameras paused because they are not visible.
  See [Adaptive quality](#adaptive-quality). With four people every tile is
  visible, so adaptive equals mixed; the saving starts at larger calls.

Egress packets/s are `N(N-1)·300` all-high, `N(250 + (N-2)·70 + (N-1)·50)` mixed,
and `N(250 + min(N-2, 3)·70 + (N-1)·50)` adaptive. Ingress is `370·N`, because
both camera layers and the microphone arrive from every Participant.

| Participants | Ingress | Egress all-high / mixed / adaptive | Total in + out, all-high / mixed / adaptive |
| ------------ | ------- | ---------------------------------- | ------------------------------------------- |
| 4            | 1,480   | 3,600 / 2,160 / 2,160              | 5,080 / 3,640 / 3,640                       |
| 8            | 2,960   | 8,560\* / 8,160 / 6,480            | 11,520\* / 11,120 / 9,440                   |

\* An eight-person all-high call would demand 16,800 egress and 19,760 total
packets/s, but the per-Episode ceiling of 11,520 (see below) stops that, so at most
8,560 egress packets/s are forwarded (11,520 less 2,960 ingress). Mixed (11,120)
and adaptive (9,440) fit under the ceiling without a screen share.
Adaptive cuts eight-person egress packets by 24% against that capped worst case
(6,480 against 8,560). That also cuts the CPU bill, not only the transfer bill.

**CPU budget.** Assume **25 µs of CPU per packet** (one SRTP operation about
2–3 µs with AES hardware support, one system call about 5–10 µs on a virtual
machine, the rest Go scheduling, interceptors and garbage collection). That is an
unmeasured guess for stock Pion without batching. It gives 40,000 packets/s per
fully used vCPU. Halve it for shared-CPU steal risk, then halve again to stay at
50% target utilization: **10,000 packets/s per vCPU**.

| Budget                           | Staging (1 vCPU) | Production v1 (2 vCPU) |
| -------------------------------- | ---------------- | ---------------------- |
| Planned packets/s, in + out      | 10,000           | 20,000                 |
| Active Participants (memory cap) | 8                | 16                     |
| Packet ceiling for one Episode   | 10,000           | 11,520                 |

**Admission reserves each Episode at its supported peak.** The supported peak is
every remote camera on `h`, every microphone, and **one screen share** with its
audio. The own provider allows one active screen share per Episode, because the
reservation counts one. For an Episode with `n` active Participants this is
`300·n(n-1) + 630·n` packets/s (the `n(n-1)` all-high term, plus `370·n` ingress
and `260·n` for one screen and its audio): 1,860 at two, 6,120 at four, 9,150 at
five and 21,840 at eight.

That peak is more than one node can carry at eight Participants (21,840 against
20,000), so the allocator **enforces a packet ceiling per Episode** and the
reservation is the lower of the peak and the ceiling. The ceiling is 11,520, the
eight-person adaptive profile with a screen share (6,480 egress, 2,960 ingress
and 2,080 for the screen), or the node budget if that is smaller. When viewers'
requested layers would exceed the ceiling, the allocator lowers the layers of the
largest set of non-speaker tiles first and keeps audio and screen. Forwarding can
then never exceed the reservation.

A Participant join is refused if it would push the sum of reservations above the
node budget, and a new Episode needs room for two Participants. The live steal
and queue-delay signals below are a second gate, not a substitute for this one.
Production therefore fits one Episode of up to eight (11,520) plus one
four-person Episode (6,120) for 17,640, or three four-person Episodes (18,360),
or two five-person Episodes (18,300). It does **not** fit two eight-person
Episodes (23,040): the second is refused as it grows. Staging fits one
four-person Episode (6,120) or one eight-person Episode held to 10,000. A
reservation above typical use is deliberate headroom against steal; once M6 has
measured real load, a later change may reserve measured use instead.

The tightest of the packet, Participant, memory and live-signal budgets wins. These are
not throughput guarantees. M6 measures the real cost per packet on
the production SKU and lowers the budget if it misses the target.
The durable admission ceiling is **500** Episode Participants, not an SFU
capacity (`apps/api/internal/episodes/service.go:75`); the eight-Participant
own-provider cap stays.

### Memory budget

Memory holds sessions and bounded packet history, so it stays small. The retransmit
history is stored **once per ingress stream** and shared by all subscribers of
that stream. A subscriber keeps only a small map from its outgoing sequence
numbers to the stored packets, so a retransmission copies, re-translates and
re-encrypts the stored packet. Keeping a full copy per subscriber would multiply the 880 KiB by up to
seven subscribers, about 6 MiB per publisher and 98 MiB across 16 Participants.

Cap each history at one second of its stream's maximum rate. One second covers a
round trip of several hundred milliseconds plus a retry; an older loss is
recovered with a keyframe request, not a retransmit. Per publisher the caps are
`h` 400 KiB, `l` 128 KiB, microphone 16 KiB, screen 320 KiB, screen audio 16 KiB:
**880 KiB**. Each subscriber transport has a pacer queue of at most 128 KiB, and
each outgoing stream an 8 KiB sequence map.

| Component                                  | Production (16 Participants) | Staging (8 Participants) |
| ------------------------------------------ | ---------------------------- | ------------------------ |
| Go runtime and binary                      | 40 MiB                       | 40 MiB                   |
| PeerConnections at 2 MiB each (guess)      | 32 MiB                       | 16 MiB                   |
| Packet history, 880 KiB per publisher      | 14 MiB                       | 7 MiB                    |
| Pacer queues, 128 KiB per subscriber       | 2 MiB                        | 1 MiB                    |
| Sequence maps, 8 KiB per outgoing stream   | 2 MiB                        | 1 MiB                    |
| Control state, replay, tombstones (capped) | 8 MiB                        | 4 MiB                    |
| **Live heap**                              | **about 100 MiB**            | **about 70 MiB**         |

With `GOGC=200` the heap can reach three times the live size, so about 300 MiB
in production and 210 MiB in staging. Add kernel UDP buffers (8 MiB) and an
assumed 300 MiB for the operating system, agents and the telemetry exporter. The
total is about 610 MiB of the production 2 GiB and about 520 MiB of the staging
1 GiB. `GOMEMLIMIT` is 768 MiB in production and 384 MiB in staging, so the
collector works harder before the kernel's out-of-memory killer acts. M6 replaces
the 2 MiB per PeerConnection and 300 MiB guesses with measurements.

### Shared-CPU risk

Basic Droplets share physical cores with other customers. When the host is busy,
the hypervisor withholds cycles from our vCPU (CPU steal). A real-time forwarder
feels this as jitter: a 20 ms stall delays every queued packet on the node, so all
calls get late media together, and the subscriber's TWCC estimator reads the delay
as congestion and cuts bitrate. DigitalOcean's documentation I checked gives no
bound for steal on Basic sizes, so treat it as unbounded until measured.

The mitigation is to see it and stop adding load:

- Export CPU steal (from `/proc/stat`), pacer queue delay and Go scheduler
  latency (`runtime/metrics`).
- Admission stops **new Episodes** when sustained steal exceeds 3% over 30 seconds
  or pacer queue delay p95 exceeds 50 ms. These are initial values that M6 tunes.
  Live calls keep running and the alarm pages an operator.
- If admission closes for either reason in more than 1% of the minutes in a week,
  move to dedicated CPUs (see [Resizing](#resizing)).

### Resizing

Moving up a size is a DigitalOcean resize. Drain the node (no new Episodes, wait for
calls to end), power it off, resize **CPU and RAM only** (disk unchanged), power it
on. DigitalOcean documents about one minute of downtime per GiB of used disk; this
disk holds almost nothing. A CPU-and-RAM resize can go back down, because the
disk is not grown. Resizing the disk is permanent, so never do it here.
A resize ends live calls just like node loss; Participants rejoin through
replacement, so do it outside calling hours. M6 rehearses a resize up and down on
staging and records the downtime and whether the public address and firewall
rules survive; DigitalOcean's resize page does not say.

DigitalOcean allows a resize only to a plan whose disk is equal or larger
([resize rules](https://docs.digitalocean.com/products/droplets/how-to/resize/)).
So the Basic sizes below are resizes, and the dedicated-CPU step is a replacement
node built by the same module, followed by a drain of the old one.

| Trigger (production)                                                     | Next step                                    | Monthly |
| ------------------------------------------------------------------------ | -------------------------------------------- | ------- |
| Memory above 70% of RAM at the admitted peak, or any out-of-memory kill  | Resize to `s-2vcpu-4gb`                      | $24     |
| Measured cost per packet is far above 25 µs and the profile shows no fix | Resize to `s-4vcpu-8gb` (still shared)       | $48     |
| Steal or queue delay closes admission in over 1% of minutes in a week    | Replacement node `c-2` (2 dedicated vCPU)    | $42     |
| Joins are routinely refused for the packet budget under real demand      | A second node, per the multi-node plan below | +$18    |
| `c-2` fails the M6 harness                                               | Replacement node `c-4` (4 dedicated vCPU)    | $84     |

For staging, memory pressure during the four-person proof moves it to
`s-1vcpu-2gb` ($12), and flaky proofs that coincide with steal move it to
`s-2vcpu-2gb` ($18). Optimize first when a profile shows a fixable hotspot
(see [Efficiency](#efficiency-on-a-small-machine)); a bigger machine is the
answer to a profile that has no hotspot left.

### Cost scenarios

The synthetic fixture is not observed customer traffic. Budget audio at 50 kbps
and add 20% for headers, RTCP and repair. Let `H=2.5`, `L=0.65`, `A=0.05` Mbps:

- All-high egress: `1.2 · N(N-1)(H + A)` Mbps.
- Mixed egress: `1.2 · N(H + (N-2)L + (N-1)A)` Mbps.
- Adaptive egress: `1.2 · N(H + min(N-2, 3)L + (N-1)A)` Mbps.
- Ingress with both RIDs: `1.2 · N(H + L + A)` Mbps.
- One 2 Mbps screen plus 50 kbps screen audio adds `1.2 · (N-1) · 2.05` Mbps of
  egress, an assumption and not an SDK-enforced cap.

| Participants | Ingress Mbps | Egress Mbps, all-high / mixed / adaptive | GiB per call-hour, all-high / mixed / adaptive |
| ------------ | ------------ | ---------------------------------------- | ---------------------------------------------- |
| 4            | 15.36        | 36.72 / 18.96 / 18.96                    | 15.39 / 7.95 / 7.95                            |
| 8            | 30.72        | 72.48\* / 64.80 / 46.08                  | 30.38\* / 27.16 / 19.31                        |

\* The eight-person all-high call is held to the 11,520 packets/s ceiling, so
its worst case is: (11,520 − 2,960 ingress − 2,800 audio) = 5,760 video packets/s
× 10,000 bits (2.5 Mbps / 250 packets/s) + 2.8 Mbps audio = 60.4 Mbps, × 1.2 =
72.48 Mbps. The uncapped formula would give 171.36 Mbps (71.82 GiB/hour), which
the ceiling makes impossible. The ceiling also counts screen packets, so this
camera-only worst case spends all of it on cameras.

For decimal Mbps, `GiB/hour = Mbps · 10^6 · 3600 / (8 · 2^30)`.
At 10 four-person staging call-hours a month, direct egress is about 154 GiB,
inside the 1,000 GiB allowance, so staging stays at $6.

For production, 500 call-hours a month on `s-2vcpu-2gb` (3,000 GiB allowance)
costs the following. These are call-hours, not participant-hours.

| Scenario                                    | GiB at 500 call-hours | Over allowance | Compute + excess per month |
| ------------------------------------------- | --------------------- | -------------- | -------------------------- |
| Four-person, all-high                       | 7,695                 | 4,695          | **$65**                    |
| Four-person, mixed                          | 3,973                 | 973            | **$28**                    |
| Four-person, adaptive                       | 3,973                 | 973            | **$28**                    |
| Eight-person, all-high, held to the ceiling | 15,188                | 12,188         | **$140**                   |
| Eight-person, mixed                         | 13,580                | 10,580         | **$124**                   |
| Eight-person, adaptive                      | 9,656                 | 6,656          | **$85**                    |

Egress above the allowance costs more than the machine once calls grow, so
adaptive quality saves more money than the Droplet size does: an eight-person
adaptive call costs about 60% as much to serve as the worst case the ceiling
allows ($85 against $140). The allowance covers
about 195 all-high or 377 mixed four-person call-hours at this size.

Add relay cost separately. If 10% of the traffic is delivered via Cloudflare TURN,
that is about 826 decimal GB a month for the four-person all-high case, up to
**$41/month**, and about 427 GB (**$21/month**) for mixed or adaptive, before any
remaining shared Cloudflare free allowance. DigitalOcean still charges its SFU
egress to the relay. With relay, the four-person production scenarios are about
**$106** (all-high) and **$49** (mixed or adaptive) a month, not a flat $18.
Real demand and shared allowance usage are unknown; replace these scenarios with
existing call-stats/usage evidence before expansion.

## Efficiency on a small machine

A small node works only if CPU per packet stays low. Profile first: the M6 proof
captures CPU and heap profiles (`pprof`, through the mTLS control listener or
from the host, never a public listener) for each load profile on the production
SKU. Every optimization below needs a profile that shows its cost before the change
and one that shows the gain after. These are candidates ordered by expected
return, not a backlog. Raw profiles stay out of Git; the PR records the function,
its share of CPU or allocation, and the measured gain.

- **Buffer pools, no per-packet allocation.** Take read buffers and outbound
  packet buffers from a pool, and hold each packet's bytes once with a reference
  count shared by the retransmit history, pacer queues and subscribers. The
  steady-state forwarding path should show zero allocations per packet in a Go
  benchmark. Evidence: allocation and garbage-collection share in the heap and
  CPU profiles.
- **Batched sends.** Write several packets per system call with `sendmmsg` on
  Linux, since each unbatched packet costs one system call. Evidence: UDP writes
  above a quarter of process CPU. This may need a [fork patch](#pion-dependency-and-fork-policy).
- **Only the interceptors we use.** Register TWCC, NACK, RTCP reports and our own
  allocator explicitly instead of Pion's full default set, and keep packet-dump
  interceptors off. Every interceptor runs on every packet. This is a design
  default, not an optimization that waits for a profile.
- **One UDP mux.** One socket on UDP 50000 shared by all sessions, which means
  fewer sockets, read loops and goroutines. Also a design default (see TURN,
  network and deployment).
- **Runtime settings for the SKU.** Set `GOMAXPROCS` to the SKU's vCPU count,
  `GOMEMLIMIT` to the memory budget above and `GOGC` to 200 in validated service
  configuration, because the live heap is small and the limit guards the rest.
  Evidence for tuning: GC share and heap in the profiles.
- **Profile-guided optimization.** Feed a merged CPU profile from the M6 load
  runs into Go's profile-guided optimization (`default.pgo`) and keep it only if
  the same load shows lower CPU per packet. Keep the profile as a build input
  outside Git until someone has checked that it holds function names and counts
  only.

The largest lever is fewer packets, not faster packets: the adaptive-quality
items cut eight-person egress packets by 24% against the ceiling-capped worst case.

## State, scaling and operations

SFU memory contains sessions, layer activity, routing snapshots, bounded packet
caches, source revision tombstones and leases. No Postgres client in the SFU;
the API authorizes control and renewals. Packet caches are transient and never
written to disk. Graceful drain rejects new Episodes, allows existing calls to
finish within an operator deadline, then triggers ordinary replacement. Readiness
includes certificate/config validity, media listener availability and drain state;
health endpoints disclose no identifiers.

V1 runs one node, which is a single point of failure. This is accepted for the
internal canary only: node loss ends every own-SFU call, Participants rejoin
through replacement, and new Episodes can be pointed back at Cloudflare. General
rollout beyond the canary needs at least two nodes with the per-Episode node
assignment below.

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
  RID, paused video, source lease expiry/revoke, packet/byte rates, repair hit/miss,
  PLI rate, TWCC feedback age, estimated bitrate, pacer drops/queue delay, CPU
  steal, Go scheduler latency, CPU/GC and memory, and the admission reason when
  new Episodes are refused.
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
