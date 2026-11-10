# Chalk SFU v1

Status: implementation proposal. Goal: replace the Cloudflare Realtime SFU for
every Tenant and Space with Chalk's Go/Pion SFU, without a new call protocol. Singapore (`sgp1`) is the deployment region, on small shared-CPU
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

Replacement is complete only after M12 covers every Tenant, Space and supported
client, including recording, and M13 retires the Cloudflare SFU. M7 is an internal
canary, not the delivery goal. Cloudflare SFU remains a tested rollback path until
M13's explicit retirement criteria pass. Cloudflare TURN is a separate product
and stays in use.

Goals:

- Audio, camera, screen and screen audio through the existing
  join/publish/pull/close flow, with bounded recovery on browsers and React Native.
- Recording and transcription capture through the same Episode-pinned provider,
  retaining the recorder's authority, privacy, artifact and cleanup contracts.
- Two-layer camera simulcast, independent subscriber quality, TWCC-controlled
  sending and bounded NACK/RTX recovery. No transcoding in the SFU.
- Low latency at the real peak, not just a successful forwarding demo. Compare
  rendered-media latency, freezes, join and recovery against matched Cloudflare
  cohorts. Bound packet queues and measure the complete M5 media path.
- Today a `s-1vcpu-1gb` staging node and an `s-2vcpu-2gb` production node in
  `sgp1`, **$24/month** total, and no other always-on node. The production node
  carries the full admitted peak. The fleet supports a degraded standby role
  (primary first; standby only when the primary is unhealthy, draining or full),
  proved on short-lived bench Droplets; production has no standby, so a drain or a
  lost node ends in Cloudflare overflow until M13 and an explicit capacity result
  afterwards. Keep staging; create bench nodes only for test runs and delete them.
- A configurable maximum of **16 active Participants per own-SFU Episode by
  default**, not a fixed eight-person cap. Packet, memory and live-health budgets
  decide actual admission. A configured maximum is not a capacity promise.
- A migration flag that starts default-off, then flips the default for every
  Tenant and Space after M12's parity gates. Provider selection is frozen per
  Episode; rollback does not silently move live media.

Non-goals: global media routing, cross-node media within one Episode, seamless
PeerConnection migration on node loss, a 500-person all-camera promise, AV1/VP9
SVC, end-to-end encryption beyond DTLS-SRTP, or replacing Sync/Postgres. Node loss
uses bounded coordinated replacement, not seamless failover. Recording is blocked
on own-SFU Episodes until M10 passes, not excluded from the finished replacement.

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

Compatibility references below describe commit
`570a3d32a996fd273e75363f9ccd08421a2197ff`. The gap audit additionally checks
`23633f571` on `origin/master`. Paths and line numbers describe the baseline,
not proposed APIs.
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
   Old SDKs use Cloudflare only during migration, and no sunset is planned; an
   unknown provider must not fall through. Public-invite arrivals follow the same
   rule: an arrival, status poll or refresh that declares `chalk_sfu` in
   `X-Chalk-Media-Providers` can bind and join an own-SFU Episode, one that
   declares nothing gets Cloudflare, and a guest whose SDK cannot run a live
   Episode's provider gets `media.client_unsupported` (409) without any provider work.
   A host's legacy approval has no guest SDK to ask, so the guest is checked when it
   collects access.
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

## Replacement gap audit

Verified means the cited code contains the dependency or contract; it does not
mean this docs PR runs the behavior. Proposed gap closures and capacity
requirements are design conclusions. The compatibility inventory above remains
the detailed wire checklist. Every row must close before full replacement, or
be explicitly identified as optional rather than silently left on Cloudflare.

| What the Cloudflare path supplies today, verified in code                                                                                                                                                                                                                                          | Own-SFU obligation                                                                                                                                                                                                                                                                                            | Milestone               |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Lifecycle, resume and separate add/update/inspect/close/renegotiate ports in `apps/api/internal/mediaplane/service.go`, `apps/api/internal/mediaplane/signaling.go` and `apps/api/internal/adapters/cloudflare/sfu/adapter.go`                                                                     | Implement every port, normalized errors, partial success, receive-only isolation, retry idempotency and honest unavailable usage.                                                                                                                                                                             | M1, M2                  |
| Provider selection and application fingerprint in `apps/api/internal/adapters/mediaplaneproviders/registry.go`, `apps/api/internal/adapters/mediaplaneproviders/binding.go` and `apps/api/internal/mediaplane/binding.go`; signaling authorization in `apps/api/internal/httpapi/sfu_signaling.go` | Resolve every operation from an immutable Episode binding. Add node placement, incarnation and fenced replacement without moving live sessions on a flag flip.                                                                                                                                                | M2, M11                 |
| Closed provider decoding, SDP roles, MID matching, publication references, partial errors, glare rollback and serialized negotiation in `sdks/typescript/client/src/access/grant.ts`, `sdks/typescript/client/src/media/client.ts` and `sdks/typescript/client/src/media/transport.ts`             | Reuse the shared client and extend provider/capability decoding. Preserve the wire contract on initial join, refresh and replacement; do not add a second signaling protocol.                                                                                                                                 | M2, M4, M6              |
| Camera RIDs and uplink/viewer policy in `sdks/typescript/client/src/media/client.ts`, `sdks/typescript/client/src/media/camera-uplink.ts` and `sdks/typescript/client/src/media/viewer-layer.ts`                                                                                                   | Correct layer translation, feedback, pacing, RTX and pause semantics, with audio protected. Visible tiles ship in M8; dynacast remains an optional M9 optimization.                                                                                                                                           | M4, M5, M8; optional M9 |
| Publication liveness and connection replacement in `apps/api/internal/mediapublications/reconciliation.go`, `apps/api/internal/providerbridge/sfu_executor.go` and the shared media client                                                                                                         | Preserve missing versus inactive evidence, bounded repulls, stale-generation fences, off debt and consent. Add own-provider ICE restart and lease-bounded source revocation.                                                                                                                                  | M2, M3, M6              |
| Native provider checks on replacement/restart and `@cloudflare/react-native-webrtc` in `sdks/typescript/react-native/src/space-client/create-native-space-client.ts`                                                                                                                               | Extend native dispatch and prove actual iOS/Android audio, video, supported screen sources, TURN and recovery against Pion. The WebRTC binding need not be replaced just because its name contains Cloudflare. Sunset incompatible native releases.                                                           | M2, M6, M12             |
| Six capture operations in `apps/api/internal/captureplane/types.go`, implemented by `apps/api/internal/adapters/cloudflare/sfu/capture_plane.go`; `apps/api/cmd/main.go` registers only the Cloudflare capture adapter                                                                             | Add an own capture adapter for create, pull, renegotiate, inspect, close-tracks and close-connection. Route by the durable binding and preserve capture identity, epochs, authority, replay and per-track failure semantics.                                                                                  | M10                     |
| `apps/api/cmd/recorder-capture/run.go` builds the Pion capture worker; `apps/api/internal/recorderworker/capture_attempt.go`, `apps/api/internal/recordingpipeline/` and `apps/api/internal/transcripts/` own downstream work                                                                      | Prove `chalk-recorder-capture` receives the own-SFU media and completes encrypted bundles, rendering, playback/export and automatic transcription. Preserve timestamp/A/V sync, codec handling, late tracks, stop/salvage, moderation privacy and orphan cleanup. Do not rebuild the pipeline inside the SFU. | M10                     |
| Owner-attributed relay policy in `apps/api/internal/mediaplane/service.go`; cached, short-lived TURN credentials with bounded minting and STUN fallback in `apps/api/internal/adapters/cloudflare/turn/turn.go`                                                                                    | Share the minter independently of the SFU adapter, retain `AllowRelay`, prove external-SFU relay/TLS-443 and credential rotation, and keep TURN on SFU retirement.                                                                                                                                            | M2, M6, M12, M13        |
| Client call stats in `sdks/typescript/client/src/media/call-stats.ts`; Cloudflare-specific failure/replacement metrics in `apps/api/internal/adapters/cloudflare/sfu/adapter.go`; terminal media reports and alerts under `infrastructure/observability/production-alerts/`                        | Add bounded own-provider correlation, packet/queue/repair/admission metrics, cohort dashboards, listener-heal evidence and tested alerts with equal operational coverage. A bytes-sent counter is not rendered-media proof.                                                                                   | M5, M6, M12             |
| Durable events and correlation in `apps/api/internal/observability/journey.go`, `apps/api/internal/observability/capture_signaling.go`, `contract/webhooks/v1/journey-events.json` and `docs/observability.md`                                                                                     | Preserve the Postgres journey ledger and executable observability proof for capture, revoke, placement/replacement and cutover failures. Carry trace and operation context through delayed cleanup; do not substitute SFU-local logs for durable evidence.                                                    | M3, M5, M10, M11, M12   |
| Deployment/tenant-managed selection in `apps/api/internal/adapters/mediaplaneproviders/registry.go`, and Cloudflare-only SDK/native grants in the files above                                                                                                                                      | Migrate all defaults, explicit Space overrides, tenant-managed configuration and supported SDK/app cohorts. Flip default-on only after recording, capacity and monitoring parity; no permanent old-SDK Cloudflare cohort.                                                                                     | M12                     |

The code verifies those seams, not Cloudflare's internal routing or redundancy.
The need for primary/standby placement, bounded capacity, health, drain, restart
and failure recovery is an operational inference from replacing a managed SFU
with disposable single-node allocations. M6 proves a node; M11 proves the fleet.
The need to remove SFU credentials, vendor-only config/fixtures and adapter code
is a retirement requirement, owned by M13, not an inference that TURN must go.

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

Two goals drive this section. First, **lower egress**: egress can become a variable cost above the included
allowance (see [Cost scenarios](#cost-scenarios)), and
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
   that sharpens over a few seconds; M5 measures that time, including the
   keyframe interval each climb waits for, and bounds it.
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
   `paused`), a reason (`congestion`, `viewer`, `source_inactive` or
   `source_unauthorized`, while the source has no live grant) and a
   revision (M4 defines it; M5 exposes it through the API and SDK transport
   behind a `subscriptionState` capability). When the receive-stall detector
   (`sdks/typescript/client/src/media/receive-stall.ts`) would call a track stalled, an own-provider session first
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
kill another device's newer publication. The provider executor dispatches
grants and revokes as source controls to the Episode's pinned node at the
operation's control revision, including the no-track case; a screen control also
covers `screen_audio`, and a removal covers every source. The node's revoke
closes only publications admitted before it, so the executor records the tracks
the node reports closed and sends no close of its own, which could otherwise
close a track a newer grant admitted.

Use short-lived forwarding leases (15-second TTL, refreshed every five seconds in
bounded batches) backed by current durable authorization. A source no control has
named does not forward; there is no flag that lets it. The API renews the newest
confirmed grant of each source while the Episode is live on the own SFU, the
Participant is present with the source's capability, and no stop was decided at
or after the grant's revision, whether or not that stop's revoke was delivered. Lost
control connectivity then stops forwarding by expiry rather than preserving a
muted orphan indefinitely. Do not extend from RTP receipt or SDK claims. Check
expiry on the forwarding path, not solely a delayed GC ticker. Lease refresh,
grant and revoke share the same revision order; a stale refresh cannot resurrect
a revoked source. Transport loss therefore has a bounded mute-enforcement window of at most the
15-second source lease, not a zero-window atomicity guarantee. Recheck the model with failing close,
orphan cleanup and delayed lease/revoke delivery.

**ICE restart:** support a client offer with new ICE credentials on an existing
session through AddTracks, returning an answer without duplicating publications.
When the own SFU advertises the `iceRestart` capability, the shared SDK restarts
ICE in place: a failed path, or one still disconnected after two seconds, sends an
`iceRestart` offer as a push with no tracks, serialized with other SDP, with one
eight-second budget before the existing replacement. The API accepts a push with no
tracks only as an offer to a plane that restarts in place, so Cloudflare is unchanged.
Restart preserves consent and off debt; it does not imply media on. Failed restart
or missing session gets a fresh bootstrap, generation and PeerConnection. Never reuse a DTLS association
across a node incarnation change. Prove Wi-Fi/mobile-style address changes and
TURN/TLS-only recovery independently of the Sync reconnect tests.

**Pull-published join:** a join used to pay a `publications` request, a `tracks` pull and a
`renegotiate` answer in sequence. When the own SFU advertises `pullPublished`, the SDK's first
poll sends one `tracks` request with `pull_published_audio` and no tracks. The API reads the
Episode's publication list, pulls every other Participant's enabled microphone and screen audio
(at most 16), and returns the SFU offer together with the list under `publications`. Video stays
out of it because the SDK waits for the UI's tile reports before pulling video, so the normal
reconcile pulls video next. The answer still goes out as `renegotiate`: it depends on the offer.
The SDK keeps only the audio of Participants on its roster and stops the rest, as the list route
does. If the combined request fails, the SDK lists and pulls the old way, so the normal recovery
(for example a replaced connection after a 410) handles the failure.
Any later poll, a replaced connection and every Cloudflare join use the list route as before.
The nightly latency sidecar leaves `join.sfu_publications` empty for a combined join, and
`join.sfu_tracks` then carries the list and the pull.

**Mute in place:** when the own SFU advertises the `muteInPlace` capability, a user
mute of the camera or microphone parks the publication instead of closing it. The
SDK detaches the track locally and sends `PUT tracks/update` with `paused: true` for
the local track, so no SDP and no `tracks/close` run and the transceiver and MID
stay. The node stops forwarding that publication at once and drops what was queued for
its subscriptions, so a muted track forwards no media within the same bound as a close.
The subscriptions stay attached and read as an idle source with a new revision, and a
viewer that subscribes during the mute gets its layer when the publication resumes. The API
records the publication as disabled with its ID unchanged. A source revoke from Sync
does not close a parked publication, and a grant keeps its lease. Unmute re-attaches the
track and resumes with `paused: false`; the node asks for a keyframe and media flows
again on the subscriptions a receiver still holds, so a receiver that missed the mute
needs no new pull. A receiver that saw the mute closes its subscription and pulls the
publication again from the next snapshot, as for any enabled publication. If the SFU no longer holds the parked publication, the SDK closes it
and publishes a new one. Cloudflare and older SDKs never see the flag, so they keep
the close path. Receivers that see the muted snapshot still tear down and rebuild
their subscription; keeping them subscribed needs a Sync and schema change that this does
not make.

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
`apps/api/internal/adapters/cloudflare/turn/turn.go:1`). Run the relay-only proof
against our SFU: being compatible with Cloudflare SFU does not prove an arbitrary
destination. A failed relay proof blocks rollout until a verified relay path
exists; do not silently switch providers.

**Decision: keep Cloudflare TURN.** It is independently usable with our SFU and
fits the free allowance at the measured traffic level. SFU and TURN share the
first 1,000 decimal GB per month, then cost $0.05/GB. Traffic between Cloudflare
TURN and Cloudflare SFU is exempt; relay traffic to our SFU is not. Count both
services during rollback windows, rather than assuming TURN has another free
1,000 GB. See [Realtime pricing](https://developers.cloudflare.com/realtime/sfu/platform/pricing/)
and the [TURN FAQ](https://developers.cloudflare.com/realtime/turn/faq/).

Revisit TURN only if relay-only interoperability fails, measured relay latency or
availability misses the media gates, shared usage approaches the paid tier, or a
security/compliance requirement rules it out. Compare the operating cost and
path quality before selecting coturn or another relay. A replacement needs its
own TLS-443 listener/address, short-lived credentials, quotas and
private-destination restrictions. SFU retirement must retain TURN credentials,
STUN/bootstrap support and renewal monitoring.

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

Chalk runs one Basic Regular `s-1vcpu-1gb` staging node and one `s-2vcpu-2gb`
production node in Singapore `sgp1`, $24/month, and keeps both (staging decided
6 November 2026; production resized to the $18 tier for full cutover). A
production standby, a second $18 node or a dedicated-CPU tier is not authorized
and nothing in the plan depends on one.

The fleet code supports a **degraded standby**: the primary is preferred for new
Episodes, and the standby takes them only when the primary is unhealthy, draining
or full, with M5 holding camera layers low and refusing admission at the smaller
packet budget. It is not two equal nodes or a guarantee that failover preserves
every peak call at full quality. Because production runs one node, that role is
proved on bench Droplets (an `s-2vcpu-2gb` and an `s-1vcpu-1gb` under one test CA),
not deployed in production.

Public list prices checked **5 November 2026**, USD before tax. Regional SKU
availability does not guarantee creation-time stock.

| Use                          | Layout                                                                                                                        | Included monthly outbound     | Compute                                      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------- |
| Staging node                 | One `s-1vcpu-1gb`, 1 shared vCPU, 1 GiB RAM, 25 GiB disk                                                                      | 1,000 GiB per full-month node | **$6/month**                                 |
| Production node              | One `s-2vcpu-2gb`, 2 shared vCPU, 2 GiB RAM, 60 GiB disk                                                                      | 3,000 GiB per full-month node | **$18/month**                                |
| Load generator or bench node | Instabox, or a disposable Droplet tagged `chalk-sfu-bench`, deleted by that tag and listed empty before the lane reports done | Prorated while created        | Free on Instabox; under $1 per run otherwise |

SFU compute totals **$24/month** today.

DigitalOcean bills per second with a minimum charge. Stopped Droplets still cost
money; delete load generators after collecting sanitized results. No media load
balancer, media disk backup or replicated packet store is required. Existing
API/Sync/Postgres, recorder compute/storage and observability costs are excluded.
Sources: [Droplet pricing](https://www.digitalocean.com/pricing/droplets),
[bandwidth billing](https://docs.digitalocean.com/platform/billing/bandwidth/) and
[regional availability](https://docs.digitalocean.com/platform/regional-availability/).

### Measured M1 capacity

The [#809 benchmark](https://github.com/Q9Labs/chalk/issues/809#issuecomment-6658827602)
runs real `sgp1` Droplets at M1 load-test commit `058901b05`. Every subscriber
receives 2.5 Mbps VP8, about 281 packets/s, plus Opus at 50 packets/s. These are
all-high synthetic streams, not the measured 0.5 Mbps workload.

| Node          | Outbound packets/s near 60% host CPU, with 8 MiB receive buffer | Initial M2 budget |
| ------------- | --------------------------------------------------------------- | ----------------- |
| `s-1vcpu-1gb` | About 20,000                                                    | 16,000 packets/s  |
| `s-2vcpu-2gb` | About 40,000, with some fixtures reaching 56,000                | 32,000 packets/s  |

Both SKUs reach an unexplained ceiling around 57,000 to 65,000 **outbound**
packets/s, about 450 to 510 Mbps, while CPU is still 62 to 75%. Loss then rises
to 10 to 15%. The single UDP socket, virtual NIC and load generator are suspects,
not proven causes. Do not extrapolate linearly past this ceiling or count a
larger SKU as a fix without a new proof.

CPU cost is 17 to 34 microseconds per datagram in plus out, about **20
microseconds** near the operating point. `sendto` accounts for about 34% of CPU.
RSS is **5 to 8 MiB per PeerConnection**. About 77% of the heap is
`packetio.Buffer.grow`, including an unread camera layer. M1 lacks TWCC,
NACK/RTX and pacing. Their expected **15 to 30% extra CPU** is an estimate, not
measured capacity; M6 measures them together.

The [#810 follow-up](https://github.com/Q9Labs/chalk/issues/810#issuecomment-6658828184)
shows default receive buffers near 208 KiB dropping packets even at modest load.
On `s-2vcpu-2gb`, loss is 0.41% at four four-person Episodes and 1.14% at eight;
on `s-1vcpu-1gb`, it is 2.3% at five. An 8 MiB buffer removes those drops in
these fixtures. Set `net.core.rmem_max`
and `rmem_default`, request `SO_RCVBUF`, and report the effective socket size.
Drain or cap unread layer buffers before M6. More RAM does not fix an unbounded
unread buffer.

The benchmark reports outbound throughput; M2 reservations and M5's per-Episode
ceiling count **ingress plus egress**. The 16,000/32,000 defaults conservatively
reduce the outbound operating point by 20%, but are not a measurement of the
finished feature set in those units. Report ingress, egress, repair, CPU and
queue delay separately in M6, then keep or lower these budgets.

### Workload and packet-rate math

Size for 10 to 12 concurrent three-person Episodes lasting about an hour, with
two cameras and one screen share active 65% of the time. Also test a rare
10-person Episode lasting at most an hour with some cameras on. Peak usage is
evening to night in Pakistan and Dubai; repeat capacity tests during that window.
These are anonymous aggregate planning inputs, not customer-specific runbooks.
October SFU egress was **103 decimal GB**, with received camera streams averaging
about **0.5 Mbps**, typically 360p to 720p. Monthly bytes do not reveal peak load
or future recording demand.

Use the following explicit assumptions, without relying on M8 or M9 savings:

- Realistic camera high layer: **60 packets/s**, rounded above 281 times
  0.5/2.5. Keep the second camera layer at **70 packets/s**, its approximate
  650 kbps cap with 1,200-byte payloads. This deliberately overstates realistic
  ingress; the October measurement is received-stream bitrate, not both RIDs.
- Worst camera high layer: **281 packets/s** from M1; low remains 70.
- Every Participant sends a microphone at **50 packets/s**, even if silent.
- One screen video at **210 packets/s**, from an assumed 2 Mbps, plus screen
  audio at **50 packets/s**. Screen rate is not an SDK-enforced cap; M6 must
  test high-motion screens and tune limits. Include screen audio even if unused.
- Every Participant receives every remote source. For the rare realistic case,
  use **four cameras and one screen share** as a conservative stated fixture,
  not an observed camera count. The rare worst case has all ten cameras on.

For `n` Participants, `k` cameras, high-layer rate `h`, low-layer rate `l=70`,
and screen duty `s` from zero to one:

```text
ingress = k(h + l) + 50n + 260s
egress  = (n - 1)(kh + 50n + 260s)
total   = k(nh + l) + 50n² + 260ns
```

The duty-weighted column is an hourly average, not simultaneous capacity. All
rates below are packets/s before repair/RTCP. M5's **11,520 ingress-plus-egress
ceiling per Episode** lowers or pauses camera video when demand exceeds it;
audio and screen have priority. Account for repair inside the enforced budget.

| Shape                                                      | Ingress at screen-on peak | Egress at screen-on peak                     | Total at screen-on peak                   | Total at 65% screen duty |
| ---------------------------------------------------------- | ------------------------- | -------------------------------------------- | ----------------------------------------- | ------------------------ |
| One three-person Episode, two realistic cameras            | 670                       | 1,060                                        | 1,730                                     | 1,457                    |
| 10 such concurrent Episodes                                | 6,700                     | 10,600                                       | **17,300**                                | 14,570                   |
| 12 such concurrent Episodes                                | 8,040                     | 12,720                                       | **20,760**                                | 17,484                   |
| 10 Episodes, same two cameras at worst high rate           | 11,120                    | 19,440                                       | **30,560**                                | 27,830                   |
| 12 Episodes, same two cameras at worst high rate           | 13,344                    | 23,328                                       | **36,672**                                | 33,396                   |
| Rare ten-person Episode, four realistic cameras, screen on | 1,280                     | 9,000                                        | **10,280**                                | Not assumed              |
| Rare ten-person Episode, all cameras high, screen on       | 4,270                     | 32,130 uncapped; at most 7,250 after ceiling | 36,400 uncapped; **11,520 after ceiling** | Not assumed              |

If all three class cameras turn on at the worst rate, the uncapped peak is
3,969 per Episode or **47,628** across twelve. No individual class reaches the
11,520 ceiling, so that ceiling alone does not protect the aggregate node.
If M5 enforces the smaller 2,400 reservation per three-person Episode as well,
twelve classes stay within 28,800 by reducing camera quality; the raw all-high
figures are demand, not promised delivered quality.
If the rare call overlaps twelve classes, totals are **31,040 realistic** or
**48,192 worst case**, with the rare call capped but the two-camera classes
uncapped. Do not use the 65% screen duty to discount these peak requirements.

### Admission and the single-node envelope

M2 owns configurable costs, node budgets of **16,000** and **32,000**, a
configurable Episode Participant limit defaulting to **16**, and an Episode
binding that records the selected node. The costs come from the SDK's camera
encodings (`h` at 2.5 Mbit/s, `l` at 650 kbit/s, 30 frames/s, a frame needing
`ceil(bytes/1150)` packets): **300 packets/s** for the `h` layer one subscriber
receives, **390** for a camera's uplink because a publisher sends every layer, and
**50** per audio stream. A deployed node measured 300 and 90 from real SDK
cameras. A Participant may publish `SFU_CAMERAS_PER_PARTICIPANT` cameras, 2 by
default, and a push of one more is refused, so the reservation is an upper bound
and admission, not a blanket pause, is the gate. Keep one active screen share per
Episode.

The nominal all-source reservation, with `m` cameras of uplink `u` and downlink
`d`, microphone `a` and screen `s` per Participant, counts every hop:
`R(n) = n·(m·u + a) + n·(n-1)·(m·d + a) + n·(s + a)`. The node reserves a screen
share at `SFU_SCREEN_STREAM_COST`, about 210 packets/s. Reserve at least two
Participants for a new Episode. M5 bounds the supported reservation by the per-Episode ceiling:
`min(R(n), 11,520, node budget)`. Before M5's enforcing allocator is enabled,
M2 must not claim that a smaller reservation bounds actual media. A second RID,
hotter video, retransmissions and capture still need measured headroom.

| Reservation                                    | Packets/s                                 |
| ---------------------------------------------- | ----------------------------------------- |
| One three-person Episode, two cameras each     | 7,170                                     |
| One three-person Episode, one camera each      | 4,200                                     |
| A new Episode's first join (two Participants)  | 3,480                                     |
| Two three-person Episodes on a 16,000 budget   | 14,340                                    |
| One Episode of four to six, two cameras each   | capped at 11,520 by M5 enforcement        |
| One Episode of seven or more, two cameras each | 35,800 for ten, capped at the node budget |

**Large calls.** A call of more than `SFU_LARGE_CALL_PARTICIPANTS` (6) Participants
shows its cameras as small tiles, and the SDK asks the low layer for a tile of 400 px
or less. Reserving every downlink at the top layer then bills about four times what is
sent: ten Participants with two cameras each came to 69,400 against about 31,000 sent.
Past that size `R(n)` bills one featured Participant's cameras at `d` and every other
camera at `SFU_SMALL_TILE_STREAM_COST` (90, the `l` layer), and the Episode's ceiling is
the node budget, because a class-sized ceiling cannot carry the call's audio and camera
uplinks. A large call never reserves less than a call at the threshold would, so a Participant
leaving cannot raise the node's total. A viewer who opens a large tile still gets `h` while the Episode stays under its
ceiling; the allocator lowers or pauses cameras beyond it as before. At two cameras each,
ten Participants reserve 35,800, so on a 32,000 node the call fills the node; fewer cameras
or a larger budget leave room for classes beside it.

Reject a join or new Episode if its reservation would exceed the selected
node's budget. Replacement must not double-count the same Participant.
The default 16 is per Episode, not a node-wide 16-person memory cap; twelve
classes already need 36 Participants. The API's durable 500-Participant maximum
is not an SFU throughput promise (`apps/api/internal/episodes/service.go`).

A configured 16-person maximum also needs a minimum-media check. At 50 audio
packets/s, sixteen microphones alone cost `50 · 16² = 12,800` in plus out;
one screen and its audio raise that to **16,960**, before camera ingress. They
cannot fit a fixed 11,520 ceiling by pausing cameras. M5 must refuse admission or
source activation when mandatory media cannot fit, or use a separately validated
higher configurable Episode ceiling within the node budget. Every camera's
uplink stays in that mandatory base, because the plan lowers only what
subscribers receive, so for a class-sized Episode at the defaults (two cameras each)
admission would refuse the tenth Participant, or the ninth with a screen share
([#836](https://github.com/Q9Labs/chalk/pull/836)). A large call (above) takes the node
budget as its ceiling, so there the mandatory media is checked against the budget. Never claim sixteen
all-audio Participants fit the default ceiling, or silently sacrifice audio.

**Primary acceptance:** prove the full admitted workload on the $18 node alone,
including capture and repair. A 32,000-budget primary admits twelve class
reservations but not those classes plus the rare call at the initial costs.
It also cannot promise the raw all-high class peak without lowering quality.
M6/M10 must calibrate reservations and enforce acceptable rate/quality limits
from the complete media path. Do not silently raise 32,000 or confuse outbound
throughput with total capacity. If the required primary envelope fails, full
cutover stays blocked pending a supported capacity/quality plan; this layout
does not authorize a second $18 node or a larger SKU.

**Standby acceptance:** prove degraded admission, drain and recovery on a bench
`s-1vcpu-1gb` standby at **16,000**, not the primary's budget. M5 caps camera selection at `l`,
protects audio and screen, bounds repair and queueing, and refuses work it cannot
carry. A single-layer publisher has no lower RID to select; pause video or refuse
the unsupported shape rather than pretend to downscale it. Screen is
single-encoding, so a low camera RID does not lower screen bitrate. Any lower
screen/uplink cap needs a separately proven publisher policy.

Under the earlier 150/50 reservation costs, which undercounted real SDK cameras,
standby would have admitted six three-person Episodes at 14,400. At the SDK-derived
costs it admits **two** three-person Episodes with two cameras each (14,340), or
**three** with one camera each (12,600). Six realistic classes at the conservative screen-on rate use about
**10,620 actual packets/s** before repair/capture, with subscribers held on
`l`. One realistic rare call held on `l` uses 10,640. These are realistic admitted workloads, not a promise of the full
twelve-class peak. Twelve realistic classes are 20,760 before repair, and their
all-source reservations are 28,800; neither fits 16,000. Lower-layer savings do
not release nominal reservations until a measured, enforced degraded reservation
profile is reviewed. Capture reduces the admitted subset further. Standby does
not carry the all-high peak.

**Decision until M13:** if primary placement is unavailable and degraded
standby refuses a **new Episode**, use Cloudflare SFU as temporary capacity
rollback. Reserve/select it before committing the Episode's provider binding,
record a bounded overflow reason, and keep it pinned. This is migration
policy, not a decision to keep Cloudflare after retirement. An
extra Participant refused in an already-bound Episode must not be sent alone to
another provider. Return capacity/retry, or use an authority-controlled whole-call
rollback that ends the old binding and creates a new Episode. No silent provider
change or cross-provider media. M13 requires zero overflow during its observation
window and removes this path; afterwards standby refusals get an explicit
capacity/retry result.

Capture is additional load, not a free Participant slot. One recorder receiving
the two cameras, three microphones, screen and screen audio adds **530 outbound
packets/s per realistic class**, or 6,360 across twelve. Simulcast input need not
be duplicated, but recorder pulls, transport, retransmission and memory count.
Twelve recorded classes plus the realistic rare call reach **37,400 total**
before repair, above 32,000. The node does not reserve that flat 530: a capture reserves the
Participant per-track cost (top layer) of each track it pulls and a pull that does not fit the node budget
is refused. M10 measures the actual capture subscription shape;
M11 reserves it in primary/standby placement and degraded failure tests.

### Memory budget

Use measured **5 to 8 MiB RSS per PeerConnection** as M1 evidence, not a live-heap
multiplier. For 36 class Participants plus ten in the overlapping rare call,
46 PeerConnections imply roughly **230 to 368 MiB** at the M1 rate before the
finished recovery/pacing/capture costs. Twelve capture connections would add
another 60 to 96 MiB. This extrapolation is not a peak-RSS proof.

Store retransmit history once per ingress stream and share packet bytes across
subscribers. Retain at most one second per stream, with these byte caps per
publisher: `h` 400 KiB, `l` 128 KiB, microphone 16 KiB, screen 320 KiB, screen
audio 16 KiB, at most **880 KiB**. A subscriber pacer queue is at most 128 KiB;
an outgoing stream's sequence map is at most 8 KiB. Bound replay/control state,
source fences and unread layer buffers. Test sparse-camera and all-source cases,
not just a fixed Participant count.

Start with `GOMEMLIMIT=768 MiB` on the 2 GiB primary and 384 MiB on the
1 GiB standby/functional node; `GOGC=200` is a tuning candidate, not a memory guarantee.
Include kernel buffers, agents and operating-system RSS. M6 requires peak total
memory below 70% of RAM with no unbounded growth over the hour-long workload,
and tunes runtime settings from CPU/heap/RSS evidence. Larger tests run on the
production size, never extrapolated from staging.

### Shared CPU, drain and resizing

Export CPU steal from `/proc/stat`, pacer queue delay and Go scheduler latency.
Stop new Episodes when pacer queue p95 exceeds 50 ms or steal exceeds a
threshold over 30 seconds. The code defaults steal to 3%, but the sgp1 $6 nodes
run at 25%: with two live classes their shared vCPU showed 10-21% steal while
pacer queue p95 stayed at 2 ms, so 3% refused a third class long before media
suffered. Keep existing media running and alert on the bounded reason.
If these guards close admission in more than 1% of minutes in a week, compare a
measured dedicated-CPU replacement rather than accepting persistent freezes.
The unexplained M1 packet ceiling still applies until diagnosed.

Planned primary deploys mark it draining. New Episodes go to the healthy
standby's degraded budget, then Cloudflare overflow until M13, or
receive an explicit capacity result. Existing primary calls, joins to those
Episodes, capture, leases and cleanup stay on the primary until completion.
This avoids interrupting live calls, but standby does not preserve full new-call
capacity. Wait for zero live allocations and cleanup debt before stopping the
primary; a deadline that forces replacement is disruptive recovery, not a
zero-interruption deploy. Prove admission behavior with hour-long calls.

On primary failure, replace whole own-SFU allocations onto standby only within
its degraded envelope, with fresh generations and M3 consent rules. Reserve
complete recovering Episodes from their known admitted shape, rather than let
individual retries consume standby in half-recovered calls. Excess existing
own-SFU Episodes need an explicit capacity outcome or whole-call rollback, not
a silent per-Participant Cloudflare route. On primary recovery, send new Episodes
to it; existing standby or overflow Episodes keep their bindings until completion.
Drain standby only while primary is healthy and has capacity. API control always
follows the binding, never a round-robin load balancer.

For resizing, drain fully, then use CPU/RAM-only resize without growing disk, or
build a replacement node and drain the old one. Do not power off active calls as
a routine deployment step. DigitalOcean's
[resize rules](https://docs.digitalocean.com/products/droplets/how-to/resize/)
require an equal or larger disk tier; a dedicated-CPU move may need replacement.
Measure a new SKU before changing budgets. More vCPUs do not prove that the
roughly 60,000 outbound-packet ceiling has gone away.

### Cost scenarios

At the observed **103 decimal GB/month**, Cloudflare SFU costs **$0**, inside its
shared 1,000 GB allowance; it then charges **$0.05/GB**. Replacing it is a control,
quality and product-completeness decision, not a saving at present usage.

The $6 staging and $18 production nodes Chalk runs today cost **$24/month**
before tax, plus disposable bench runs. Their full-month combined transfer
allowance is **4,000 GiB**, subject to the team pool. 103 GB is about **95.9 GiB**,
even all through the production node below its 3,000 GiB. DigitalOcean ingress is
free and excess outbound is $0.01/GiB. The own-SFU egress estimate stays $0 at
this volume if other team workloads have not consumed the allowance. Formula:
`$24 + $0.01 · max(0, SFU GiB - available pooled GiB) + test compute + TURN`.

Cloudflare TURN stays **$0** while total billable Realtime egress, including any
rollback SFU traffic, is below 1,000 GB. For example, even relaying all 103 GB
of received SFU media plus the workload's publisher uplink fits that allowance
at the current call shape. Do not treat 103 GB as a measurement of both relay
directions or of future recording traffic. SFU egress to TURN also consumes
DigitalOcean transfer. Monitor actual invoices/usage rather than charging a
hypothetical paid TURN percentage from the first byte.

For scale context only, a realistic class uses about **2.68 GB of egress per
hour** with 65% screen duty, using 0.5 Mbps per received camera, 50 kbps per
microphone and a 2 Mbps screen with 50 kbps screen audio, plus 20% headers/repair.
Twelve such class-hours in one busy hour are about **32.2 GB**. The duration and
number of busy evenings per month are not measured, so do not multiply the peak
into a fabricated monthly bill. Capture and its separate compute/storage add
cost; M10/M11 refresh the budget before cutover.

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

Avoid forwarding unused video before optimizing packet writes. M8 and M9 can
reduce packets, but capacity and failure proofs must state whether they are on;
M9 remains optional and cannot hide an undersized baseline.

## State, scaling and operations

SFU memory contains sessions, layer activity, routing snapshots, bounded packet
caches, source revision tombstones and leases. No Postgres client in the SFU;
the API authorizes control and renewals. Packet caches are transient and never
written to disk. Readiness includes certificate/config validity, media listener
availability and drain state; health endpoints disclose no identifiers.

M2 records the chosen node in the Episode binding from the first own-SFU Episode.
M11 adds primary-first placement, degraded standby, health, drain and failover. Keep one Episode on
one node. Provider/application identity stays fixed for the Episode; node loss
changes placement only through a durable, generation-fenced recovery transition.
Use the node assignment and boot incarnation for every operation, including
capture and deferred cleanup. Reject stale responses from a replaced node and
retain cleanup targeted at the old allocation rather than sending it to the new
one. Admission prefers primary and uses standby only when primary is unhealthy,
draining or full. Reserve capacity atomically; never round-robin session control
or treat both nodes as equal-capacity destinations.

Primary loss requires fresh grants, sessions and PeerConnections on standby
within its degraded envelope, using M3's consent/off-debt rules. There is a
bounded interruption for admitted recovery and an explicit outcome for excess
demand, not seamless or full-capacity transport migration. A selector flip cannot perform this recovery.
Test concurrent API placement, lost control acknowledgements, old-node return,
failed lease renewal and standby overload. No Redis correctness authority
or cross-node packet replication is needed.

Follow [observability](../observability.md): carry `traceparent`, allowlisted
`session.id` baggage and existing journey/operation context from API to SFU and
through deferred cleanup. A provider session ID is not the device's `session.id`.
Export structured OTLP logs/spans using private runtime configuration.

- Counters/gauges: active sessions/publications/subscriptions, requested/effective
  RID, paused video, primary/standby role, degraded admission/overflow outcomes,
  source lease expiry/revoke, packet/byte rates, repair hit/miss,
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

M7 selects only internal, accountable-owner Spaces without capture dependencies
until M10 passes. Compare matched network/codec/call-shape cohorts against
Cloudflare, including TCP-443-only callers. Gate on successful join,
audible/rendered media, privacy, recovery and resource budgets, not just HTTP.

M12 performs full cutover only after M8, M10 and M11 pass alongside M1–M7.
Release compatible shared and React Native SDKs and first-party apps first.
Inventory every Tenant default, Space override, tenant-managed provider config
and recording/transcription dependency. Migrate explicit
Cloudflare selectors as well as defaults. A client that
does not declare `chalk_sfu` gets Cloudflare or an explicit
`media.client_unsupported` (409), never a misdecoded own-provider grant. Chalk
has no outside clients, so no client sunset is planned.

Expand the migration flag by cohort, then set the deployment and every Tenant's
default to `chalk_sfu`, with no forgotten Space override. New Tenants and Spaces
inherit it. Existing Episodes retain their provider until they end or take an
explicit authority-controlled replacement. Cover join, grant refresh, reconnect,
capture start/stop, artifacts, diagnostics, alarms and support queries for every
supported client. The completion proof counts bindings and traffic, not just a
configuration default. Keep both adapters and rollback credentials through M13.

**Rollback before retirement:** switch selection back to Cloudflare for new
Episodes while preserving live own-SFU bindings. For unhealthy active Episodes,
use an explicit coordinated rejoin/replacement through authority, preserving mute
and consent. Keep the own adapter, node and capture cleanup until all its bound
work drains. No destructive schema reversal is required. Rehearse the same
behavior after default-on cutover, not just during the internal canary.

**Cloudflare SFU retirement:** M13 requires 7 consecutive days after full cutover
(extended until the criteria hold) covering evening peaks and a matched synthetic peak, with all Tenants/Spaces and supported browser/native
cohorts on the own provider; no unresolved privacy, recording, media or capacity
regressions; and proven full single-node primary peak plus degraded-standby
drain/recovery gates with documented refusals. Require zero Cloudflare overflow
throughout the window, including during deploys and failure drills. Require zero
live Cloudflare SFU Episodes, capture sessions, pending retries/cleanup and
legacy-client demand, and zero Cloudflare SFU signaling during that window.
Rehearse rollback before the observation window closes. Only then remove the
Cloudflare SFU adapter, selector branches, SFU credentials/configuration,
obsolete fixtures and vendor-only dashboards. Keep compatible historical binding
and artifact readers until their retention/migration obligations are met. Retain
Cloudflare TURN and any strictly required credential scope. Retirement ends flag
rollback; later rollback requires redeploying the retained last compatible
release, so deletion is a separate explicit release decision.
