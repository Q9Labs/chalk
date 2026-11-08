# SFU implementation milestones

Each milestone is a mergeable unit, split into focused PRs when needed. M1–M7
prove an internal canary, not the finished replacement. Full cutover requires
M1–M8, M10 and M11; M12 moves every Tenant and Space; M13 retires Cloudflare SFU.
M9 remains an optional efficiency improvement. The migration flag starts off and
becomes default-on in M12. [Design](design.md) owns the contracts, capacity gates
and temporary exclusions. Provisioning follows the [hosting decision](design.md#hosting-and-budget),
not these docs alone.

Run heavy Linux/browser/load checks on Instabox. Chalk runs a $6 `s-1vcpu-1gb`
staging node and an $18 `s-2vcpu-2gb` production node in `sgp1`, $24/month, and
keeps both; no other always-on node is authorized. Multi-node proofs use staging
or short-lived Droplets tagged `chalk-sfu-bench` that are deleted the same day
(under $1 per run). Real `sgp1` capacity proofs run on the production node's size,
not the Air. Chalk has no active users yet, so M6 and M7 carry no rollback plan:
M7 verifies the live media plane instead. The design identifies workload
combinations that do not fit the initial reservation budgets; a passing canary
must not conceal that full-cutover blocker.

## M1 — Service skeleton and real single-layer push/pull

**Scope:** create the standalone Go module at `features/media/sfu/`. Implement
bounded configuration, mTLS control on the public TCP 8443 listener, `/healthz`, `/readyz`, graceful stop,
session creation, push, pull, renegotiate, forced track close and inspection.
Start with VP8/Opus passthrough on a Pion UDP mux. Scope every session/reference
to Tenant/Episode/Participant/generation. Define the versioned wire DTOs in public
`protocol/`; do not import `apps/api/internal`. Return stable track identity,
correct SDP roles and normalized per-track errors. Add operation-ID replay for
session creation only; M2 adds it for the other mutations. No SDK/API wiring, layer adaptation, deployment,
recording support or production authorization flag in this PR.

**Files:** `features/media/sfu/{go.mod,go.sum,cmd/sfu/,protocol/,internal/}`,
**features/media/sfu/tests/loopback_test.go** (planned), service README and gate registration
where the repository gate runner discovers standalone Go modules.

**Check:** a `go test -race ./...` integration test starts the real HTTP service,
uses two real Pion peers, pushes known RTP on peer A, pulls through peer B,
answers the SFU offer through Renegotiate, and asserts received audio/video
payload and increasing packet sequence. Close stops forwarding; inspect marks
absence; duplicate create returns one session; a wrong client certificate and
cross-Tenant pull fail. All peers/listeners/goroutines close at test completion.
The command runs from `features/media/sfu` on Instabox.

A second check runs one headless Chromium peer against the same service. It
pushes a fake camera and microphone through a plain `RTCPeerConnection`, using
the SDK's SDP shape (BUNDLE, MID-named tracks, a server offer answered on pull),
and pulls them back on a second connection; the test asserts decoded frames and
audio packets. Pion-to-Pion can pass while browser SDP fails, so M1 finds that
early instead of in M2 or M6.

**Risk:** a forwarding demo can hide broken signaling or resource cleanup.
Exercise HTTP and actual peers in the same test, not a mocked media writer.

## M2 — API adapter and frozen provider selection

**Scope:** implement lifecycle and signaling ports in `adapters/chalksfu`; add
`chalk_sfu` to provider schemas, authenticated media grants and SDK provider
dispatch, reusing the existing media client. Complete negotiated/receive-only
close and no-SDP track updates. Add operation-ID replay for every mutation the
adapter retries. Preserve partial responses and existing public
route flow. Persist provider/application and selected node binding at Episode
creation. Resolve every later operation from it, including refresh, cleanup and
capture exclusion; M11 extends placement rather than inventing a second binding.
Add the default-off Tenant/Space migration selector. Replace the fixed eight-
Participant cap with a configurable per-Episode maximum, default **16**. Admit
by configurable stream costs, initially **150 video and 50 audio packets/s**,
and node budgets of **16,000** on `s-1vcpu-1gb` or **32,000** on
`s-2vcpu-2gb`. These budgets count ingress plus egress. Reserve an Episode's
supported peak, with room for at least two Participants and one screen share;
reject joins above the node budget. M5 adds the enforcing per-Episode ceiling.
See [admission](design.md#admission-and-the-single-node-envelope).

Advertise capabilities but leave server adaptation/ICE restart false until their
milestones pass. Reject capture before reserving work until M10 supplies it.
Keep incompatible SDK cohorts on Cloudflare only during migration; M12 upgrades
or sunsets them and makes the own provider the default for all Tenants/Spaces.
Do not implement multi-node failover or the full-cutover operation in this lane.

**Files:** `apps/api/internal/{adapters/chalksfu,adapters/mediaplaneproviders,
mediaplane,accessgrants,httpapi,episodes,spaces}`, authoritative contract/schema
inputs and generated output; `sdks/typescript/client/src/{access,connection,media}`;
React Native grant/bootstrap consumers; additive binding persistence if needed.

**Check:** reusable `mediaplane` conformance cases run against the real local SFU
and a disposable Cloudflare application in an opt-in integration job. Check
create/resume, push/pull/answer, mixed success/error, layer-update envelope,
negotiated and forced close, receive-only isolation, inspect, remove/end and
unavailable usage. Ordinary CI runs the self-hosted half; Cloudflare fixtures
cover decoding but do not substitute for the opt-in provider run. Flip selection
during a call: old Episode stays pinned, next Episode uses the new provider.
Verify the configured Participant limit, including a limit above eight, and
packet-budget refusal before that limit when capacity is exhausted. Check node
binding survives selector changes, replacement does not double-count capacity,
a second concurrent screen share is refused, capture is temporarily excluded,
and old/new SDKs are distinguished. Check
401/403 isolation, `pnpm run regen` and `pnpm run check:generated`.

**Risk:** provider switches are currently closed vocabularies; a change only in
the registry leaves credentials, SDK refresh or cleanup Cloudflare-only. The
current signaling resolver also reads mutable Space configuration.

## M3 — Source fencing, off debt and transport recovery

**Scope:** implement grant/revoke controls and monotonic source fences, including
off with no publication. Extend the existing durable provider-effect path rather
than issuing best-effort stop calls from an SDK. Add bounded forwarding leases
and authorization-based renewal. Update the Cloudflare-shaped executor dispatch
to use the pinned provider. Add own-capability-gated in-place ICE restart on the
shared SDK SDP queue; retain session replacement as bounded fallback. Preserve
off debt, newer host stops, two-device ownership and #745 consent rules.

**Files:** SFU `internal/` source/session lifecycle and `protocol/`;
`apps/api/internal/{providerbridge,provideroperations,mediapublications,adapters/chalksfu}`;
`apps/sync/lib/chalk_sync/{live,stateholder,provider_bridge}` only where durable
source effects need extending; SDK `sdks/typescript/client/src/media/client.ts` and existing media-recovery
tests. Bring in/update `tools/formal/media-control/` from the model branch without
raw private artifacts; store model configs and bounded results.

**Check:** replay model counterexamples as executable integration scenarios:
lost off, failed on followed by reconnect, duplicate/delayed command, off with no
track, newer host stop during pending capture, and another device publishing.
Assert local muted capture never resumes, on UI waits for Sync, off debt survives
and converges after faults stop. Drop revoke delivery and lease refresh: media
ceases by the lease bound; deliver stale refresh/push after revoke: no resurrection.
Restart ICE while publishing and while pulling, then force restart failure and
node loss; verify fresh generation, no duplicate publication and eventual audible
receive. Recheck the model with non-atomic revoke/failing close rather than claiming
the idealized own-SFU variant proves the distributed service.

**Risk:** a stale source enable or lease refresh can defeat moderation. Modeling
atomic HTTP-to-Postgres revoke would conceal this failure. Missing publication
must not be mistaken for a host stop.

## M4 — Simulcast routing and subscriber layer policy

**Scope:** receive `h`/`l`, support single-layer fallback, switch one subscriber
without altering another, and preserve MID/track identity. Implement keyframe
gating, RTP/codec identifier translation, unavailable-RID fallback, source
inactivity and PLI throttling. Land requested-ceiling versus effective-layer
state for M5, plus a `paused` state: a subscription that forwards nothing, keeps
its MID and track identity, needs no SDP, and resumes on a keyframe. Let a pull
or update name its starting layer, so M5 can start on the low layer. Report each subscription's
state (`active` or `paused`, reason, revision) in the inspect result. Keep the
packet history once per ingress stream, shared by subscribers, with a per-subscriber
sequence map. Decide whether a third, lower camera layer pays for itself (see
[Adaptive quality](design.md#adaptive-quality)). Attribute any borrowed LiveKit
units. Keep adaptation capability false until feedback and pacing work.

**Files:** SFU RTP routing/layer modules and tests; the planned **THIRD_PARTY_NOTICES.md**;
shared API adapter conformance cases; SDK capability type/decoder if needed; the
adaptive-quality section of the design with the third-layer decision.

**Check:** one real two-RID publisher and two subscribers request opposite
layers; both decode. Switch repeatedly under keyframe delay, sequence wrap and
packet reorder; identity stays stable and output has no sequence discontinuity
that defeats decoding. Pause `h`, then `l`, then test a publisher with no RIDs:
the remaining valid stream flows. Test `asciibetical` ordering and per-track
errors. Pause a subscription: it receives zero RTP, its MID and track identity
stay, no SDP is exchanged, inspect reports it `paused` with its reason, and resume
waits for a keyframe without disturbing another subscriber. Retransmit from the shared history for two subscribers on
different layers and assert each gets its own sequence numbers. For the third
layer, publish a headless Chromium camera with two and with three encodings and
record encode CPU and decoded resolution; the PR states the decision and the
numbers, and adds the layer (own-provider only) only if justified.
Chromium/Firefox/WebKit interop runs in M6, not a fake peer claim here.

**Risk:** selecting an SSRC is not sufficient for decoder continuity. LiveKit
code may depend on its own RTP buffers, clock types or Pion fork.

## M5 — Congestion control, retransmission and observability

**Scope:** wire ingress TWCC, per-subscriber GCC feedback, transport sequence
rewriting, pacing, bounded NACK/RTX history and audio-first allocation. Enable
`serverLayerAdaptation` only for the own provider; treat SDK layer requests as
ceilings and keep the Cloudflare behavior unchanged. Start a new own-provider pull
on the lowest layer its ceiling allows and climb as the estimate supports it.
Hold each Episode to its packet ceiling (the lower of its supported reservation,
11,520 ingress-plus-egress packets/s and the node budget) by lowering non-speaker tile layers first. Pause video and keep
audio when the estimate cannot carry the lowest layer, and resume with
hysteresis. Expose subscription state through the API and SDK transport behind a
`subscriptionState` capability: the SDK's receive-stall check reads it before
declaring a stall, shows a distinct "video paused for network" state for a
paused subscription instead of repulling, and re-reads it until RTP resumes.
Where the capability is present the SDK also pauses off-screen video in place
using M4's pause state. Export CPU steal, Go scheduler latency and pacer queue
delay, and stop new Episodes when steal exceeds 3% over 30 seconds or queue delay
p95 exceeds 50 ms, with the admission reason in telemetry. Add bounded operational
telemetry and client-stat provider correlation; document alarms and journey
evidence. Pin the one-second, per-stream byte caps and pacer queue limit from the
[memory budget](design.md#memory-budget) in configuration, not unbounded maps.

**Files:** SFU interceptor/pacer/allocator modules; SDK capability consumption and
call-stats schemas as needed; API stats allowlists; `docs/observability.md`,
journey ledger/proof definitions for changed lifecycle boundaries.

**Check:** reproducible network impairment harness with a real receiver:
constrain only one subscriber, assert it drops quality while the other stays
high, microphone packets/rendering continue, and quality rises after recovery.
A new pull starts on `l` and reaches `h` on an unconstrained path inside a stated
time that includes the keyframe interval, while a Cloudflare-provider session still requests `h` first. Constrain a
subscriber below the lowest layer: it goes audio-only with the paused-video state,
no repull occurs through a pause lasting past the seven-second stall window, and
video returns only after the estimate holds. A ten-person all-high call with a
screen share stays at or below 11,520 ingress-plus-egress packets/s, including
repair, with audio intact. A screen share reserves `SFU_SCREEN_STREAM_COST`, about
210 packets/s. A revoked or muted source stops forwarding within the 15-second
source lease, so the mute window is at most 15 seconds. Also test the configured 16-Participant maximum and mandatory-media admission:
sixteen microphones alone need 12,800 packets/s, so the default 11,520 ceiling
must refuse that shape unless a higher configurable ceiling has been validated.
Do not drop required audio to make the test pass. A configured maximum is not
an all-source quality guarantee. Inject loss on each leg and
assert actual NACK plus RTX packets and decoder recovery, with repair memory/rate
bounded at the configured caps. Feed a fake steal reader and a delayed pacer:
admission refuses new Episodes at each threshold and existing calls continue.
Verify requested/effective RID,
feedback age, queue delay and correlated failure evidence; scan exported logs
for forbidden SDP, IPs, secrets and payloads. Require a real rendered-media
assertion in M6, not just bytes emitted by the SFU.

**Risk:** duplicated TWCC sequence spaces, unlimited retransmits and competing
SDK/server upswitch loops can worsen congestion. Starting low must not leave a
large tile blurry for long. Missing audio TWCC support
must not cause audio starvation; retain an audio budget and conservative fallback.

## M6 — Reproducible sgp1 staging and production nodes

**Scope:** deploy the SFU to the two `sgp1` `s-1vcpu-1gb` nodes, staging and
production, from an OpenTofu module and a deploy script: image, runtime settings
from the [design](design.md#memory-budget), host and cloud firewalls (media UDP
open, control reachable only from the API), service-identity mTLS certificates
and their rotation, private telemetry and single-node drain. Wire the staging API
to the staging node with the switch on for internal Spaces only. Production gets
the same build and keeps the switch off until M7. Reuse Cloudflare TURN and prove
relay to our SFU. Primary-first placement and degraded failover belong to M11.

Before staging, set the host and socket receive buffer to 8 MiB, report the
effective size, and drain/cap unread layer buffers from the
[#810 follow-up](https://github.com/Q9Labs/chalk/issues/810#issuecomment-6658828184).
Measure the finished M5 feature set against the
[M1 evidence](design.md#measured-m1-capacity), including the estimated 15 to 30%
CPU overhead, instead of treating M1 throughput as a finished-SFU guarantee.
Profile each load on the production node's size. A profile-justified optimization
or Pion fork patch is a separate PR; M7 waits only if it fixes a failed budget.

**Files:** deployment composition under `infrastructure/`, SFU image/runtime
configuration, browser/network proof scripts and public guidance without real
addresses, credentials or private runbooks. Put shared media deployment behavior
in the media feature; do not add unrelated app-specific orchestration.

**Check:** supported browser and native peers use the real API/Postgres/Sync
path with rendered audio/video and screen audio. Include Chrome-like two-RID,
Firefox single-layer, WebKit and real iOS/Android behavior, delayed publication
propagation, missing-subscription repull, path change, 60-second offline,
process kill/restart and outbound-TCP-443-only relay. Replay #761 off-reason
proof for the candidate and supported prior SDK sockets.

The starting capacity bar is six concurrent three-person classes on the $6 node,
in the target workload's shape: two cameras, a screen share 65% of the time,
one-hour evening classes and a rare ten-person call. Run that for an hour,
then step up to find the node's real envelope: more classes, an all-screens-on
burst, the ten-person sparse-camera call and its all-high case (at or below
11,520 packets/s with audio intact), and the 16-person ceiling case, which
admission refuses at the fourteenth Participant, or the twelfth with a screen
share ([#836](https://github.com/Q9Labs/chalk/pull/836)). Report refusals and
quality loss, not just admitted-call throughput. This distinguishes the measured
workload, supported admission envelope and unsupported raw worst case.

Record actual ingress/egress/repair packets, admitted reservations, forwarded
sources, rendered resolution, CPU, steal, GC, scheduler/pacer delay, peak RSS and
transfer. Keep the initial 16,000/32,000 budgets unless complete measurements
justify a reviewed calibration ([current calibration](capacity-calibration.md)); never silently change units or use M8/M9 savings
to hide missing baseline capacity. Require below 70% total RAM, no growing
buffers, no receive-buffer drops, bounded repair/queues and no unexplained media
loss. Repeat in evening-to-night Pakistan/Dubai windows and report the spread.
Capture profiles privately and publish sanitized summaries only.

For low latency, compare rendered end-to-end p50/p95 and freeze rate with a
matched Cloudflare cohort at the same load, codec and network. Require no p95
latency or sustained freeze regression; report SFU processing/queue delay apart
from encode and network latency. Keep M7's join/recovery thresholds as separate
gates. Starve CPU and expire TURN credentials to prove admission guards, renewal,
alerts and bounded recovery. Load generators run on Instabox, or on disposable
Droplets tagged with the lane's own tag, `chalk-sfu-bench-<lane>`, and deleted by that tag after each run. The tag list must be empty before the lane reports done.

**Risk:** shared CPU and generator limits can distort one run. Staging matches
production's size, so its results carry over, but one run is not a capacity
guarantee. Full cutover waits for M10's capture demand and M11's placement and
failover proof. If relay, native interop, consent, recovery or capacity evidence
is absent, keep the migration flag off for affected cohorts.

## M7 — Internal canary and live verification

**Scope:** make the default-off allowlist configurable for internal Spaces after
M1–M6 are green; preserve Cloudflare elsewhere during migration. This is an
intermediate proof, not the final adoption boundary. Add cohort dashboards and
automated canary checks. Rollout is an operational step after this PR, not an
automatic consequence of merging it. Keep both adapters installed.

**Files:** provider selection/runtime configuration, proof scripts, observability
queries and public rollout guide. Private allowlists live outside Git.

**Check:** at least 20 scripted joins and 10 fault/recovery trials per provider
under matched network/call shape; zero cross-Tenant or mute/consent failures,
all stable-network joins render audio/video within 10 seconds, and all short
transport faults recover rendered media within 15 seconds after network restore
without manual toggles. Long-drop cases intentionally remain off pending fresh
consent. These are initial acceptance thresholds, not statistical SLO claims.
Then run internal usage for seven days with no unresolved privacy/authority
failures or persistent listener-unpulled alarm and within M6 capacity limits.
Once the media plane is live, test it end to end, stress it and hunt edge cases
on the live node: a killed node recovers by explicit rejoin, outstanding cleanup
drains, and a live own-SFU Episode stays pinned when the selector changes.

**Risk:** a one-node canary can lose all own-SFU calls until replacement. That
is acceptable only for this internal proof. M11 supplies primary-first placement,
degraded standby admission and drain/failure proof, and M12 supplies recording/client/monitoring parity
for full rollout. Changing the selector does not move live sessions; removing an
adapter early strands calls and cleanup. Canary evidence does not establish
500-Participant capacity or authorize general rollout.

## M8 — Visible-tile video subscriptions (independent, provider-neutral)

**Scope:** the SDK pulls remote camera and screen video only for tiles on screen,
closes the pull after a debounce when a tile leaves, pulls the next page early,
and always keeps audio. Add `setVideoTileVisibility(publicationId, {width, height} | null)`,
keyed by publication so it works before a track exists; it is local and sends
nothing to the server. A publication the UI has not reported is unknown: the SDK
waits up to 250 ms for the first report, then pulls it as today, so a UI that
never calls it behaves exactly as before. `null` means hidden and pulls no video. It uses the existing pull and close calls, so it changes
Cloudflare behavior as well as the own provider's, by design. It does not depend
on M1–M7 and can ship before or after them. Egress and packet savings apply to
Cloudflare today.

**Files:** `sdks/typescript/client/src/media/` (viewer policy and pull
scheduling), React and React Native consumers of tile visibility, SDK tests.

**Check:** a browser test with a mocked grid of eight remote Participants shows
only four tiles: exactly four video pulls plus eight audio pulls exist; scrolling
a tile into view pulls its video and renders it inside a stated time; scrolling
away closes it after the debounce; rapid scrolling creates no pull storm and no
leaked PeerConnection transceivers. A UI that never reports visibility pulls
every video exactly as before, and a tile reported before its track exists is
pulled or skipped on that first report. Existing media-client recovery tests still
pass, and received video bytes for the hidden tiles are zero in the call-stats.

**Risk:** a scroll-back delay reads as a frozen tile. The early pull and
debounce trade that delay against egress; tune both from the test, not guesses.

## M9 — Dynacast (own provider)

**Scope:** after M3, M4 and M5. The SFU computes per-source demand (highest
requested camera ceiling across subscribers), returns it to the API, and the API
relays it to the publisher over the durable source-control path. The SDK applies
it as information, not a command: a layer is enabled when it is demanded and
`CameraUplinkPolicy` allows it, with a floor that enables the cheapest demanded
layer (or `l` when nothing is demanded) if the rule would otherwise disable every
layer. Disable an undemanded encoding after a hold time, re-enable at once on a
new request, and keep forwarding the remaining layer until the re-enabled layer
has a keyframe. Gated
behind an own-provider capability; Cloudflare publishers are unchanged.

**Files:** SFU demand tracking and `protocol/`; `apps/api/internal/{adapters/chalksfu,
providerbridge}`; `sdks/typescript/client/src/media/camera-uplink.ts` and tests;
authoritative contract inputs and generated output.

**Check:** with a real two-layer publisher and two subscribers: both on `l`, the
publisher stops encoding `h` after the hold time and ingress packets for `h` drop
to zero; a third subscriber requests `h`, receives `l` until the `h` keyframe,
then switches without a frozen picture; with every viewer on `l` and the
uplink measured at 1 Mbps, `l` stays enabled (the uplink policy alone would turn it
off) and a viewer still receives video, including while demand changes; drop the relay message and the stale
state heals on the next lease refresh; a missing capability leaves both layers
running. Run `pnpm run regen` and `pnpm run check:generated`.

**Risk:** a demand message lost or delayed after a revoke must not resurrect a
source; reuse the M3 revision fence. Disabling too eagerly makes every new tile
wait for a keyframe. M6 records capacity with M9 off, so M9 cannot hide a miss.

## M10 — Recording and capture parity

**Dependencies:** build on M2's provider/binding and capture exclusion seam.
Coordinate M3 fences and M4/M5 track behavior; acceptance requires M3–M6. This
lane can run alongside M8/M9 and M11 after their shared contracts are agreed.

**Scope:** implement all six `CapturePlane` operations for the own provider and
register the adapter alongside Cloudflare during migration. Resolve capture by
the authoritative Episode provider/node binding, not the current Space selector.
Reuse the existing capture signaling coordinator, `chalk-recorder-capture` Pion
worker, recording pipeline, render/export and transcription paths. Preserve
capture epochs, plan revisions, operation replay, worker authorization, privacy,
moderation, stop/salvage and bounded cleanup. No SFU-side recording database or
second artifact pipeline. Remove own-provider capture rejection only once parity
passes; recording/transcription Spaces must not be permanently left on Cloudflare.

**Files:** `apps/api/internal/{captureplane,captureproviders,capturesignaling,
recordercapture,recorderworker,recordingpipeline}`; the own-SFU adapter and protocol;
`apps/api/cmd/recorder-capture/`, API composition, capture plans and integration
proofs. Change downstream render/transcription code only where the real proof
finds a provider dependency.

**Check:** record a real own-SFU Episode with microphone, camera, screen and
screen audio through `chalk-recorder-capture`. Verify decoded recording playback,
A/V timestamps/sync, late publish/unpublish, layer switches, supported codecs,
encrypted bundle/manifest completion, render/export and automatic transcription.
Mute/host stop must end captured media within the authority bound. Test missing
tracks, transient pull errors, duplicate retries, expired worker grants,
recorder/SFU restart, capture epoch replacement and interrupted-stop salvage.
No stale epoch may append to a newer recording; close leaves no SFU capture
sessions or durable work stranded. Check journey/trace correlation, authorization
and public/private artifact access. Measure extra packets, PeerConnections, CPU,
RSS and transfer per capture slot, then publish costs for M11's fleet sizing.

**Risk:** live-media parity does not imply capture parity. A recording can look
successful while missing audio, drifting timestamps or retaining muted media.
Recorder capture load must be reserved; it cannot bypass the node packet ceiling.

## M11 — Primary placement, degraded standby and drain

**Dependencies:** M2 records the node in the Episode binding. M3 generation and
source fences, M5 budgets and M6 capacity evidence apply. Work packages 1–5 do not
wait for M10 and run in parallel with it; package 6 (the capacity proof) includes
M10 capture. M11 owns placement, the allocator, drain and recovery; M10 owns
capture code, and the two share only `ReadyResponse`, `features/media/sfu/protocol/protocol.go`,
`features/media/sfu/internal/media/admission.go` and
`apps/api/internal/adapters/chalksfu/adapter.go`, where each change lands as its own small PR.

**Topology:** production runs **one $18 `s-2vcpu-2gb` node** and staging one $6
`s-1vcpu-1gb` node, $24/month, and no other always-on node is authorized. The fleet
code takes any number of nodes in placement order, with a `primary` or `standby`
role, so a second node is configuration and not new code. Multi-node behavior is
proved on two short-lived `sgp1` bench Droplets tagged `chalk-sfu-bench` (an
`s-2vcpu-2gb` primary and an `s-1vcpu-1gb` standby, about $0.04/hour) under one
test CA, deleted the same day. Staging never serves production traffic, so it is
not a production standby. Production with one node has no failover target:
planned replacement is drain, restart and rejoin on the same node, and a lost
node ends in an explicit capacity result until the M6 infrastructure rebuilds it.
A production standby ($6/month) or a larger primary is an owner decision outside
this plan, and nothing here depends on it.

**Current code:** `Fleet.Place` already picks the first ready node with packet
budget left, skips silent nodes, and starts a new Episode on Cloudflare when none
has room. The SFU already drains on SIGUSR1: it refuses new Episodes, keeps live
calls and fails readiness, and `deploy/deploy` waits for it. Missing: node roles
and a degraded envelope, an API-reachable drain with allocation and cleanup-debt
counts, boot incarnation in the binding, recorded placement and overflow reasons,
an overflow switch, whole-Episode recovery, and every proof below.

**Work packages**

1. **Placement record and overflow switch.** Add the placement reason (`primary`,
   `standby`, `overflow:<bounded reason>`) and the node's boot incarnation to the
   binding's JSON, additively and without a schema bump. Add a placement counter
   with bounded labels. Add `CHALK_SFU_CLOUDFLARE_OVERFLOW` (on until M12 ends).
   With it off and no node with room, creating an Episode returns the explicit
   capacity/retry result. Files: `apps/api/internal/adapters/mediaplaneproviders/binding.go`,
   `apps/api/internal/mediaplane/binding.go`, config,
   `apps/api/internal/observability/media_plane.go`.
2. **Drain control.** `/readyz` reports `draining`, live allocations (sessions,
   leases and capture sessions) and cleanup debt. An mTLS drain request replaces
   SIGUSR1 as the control path, with an undrain for an aborted deploy. The
   deploy script waits for zero allocations and zero debt, and a forced deadline
   is logged as disruptive replacement. The API probe tells a draining node from
   a silent one.
3. **Roles and degraded envelope.** A node entry carries `role`. A standby takes
   a new Episode only when every primary is unhealthy, draining or full, and
   runs at a configured degraded budget (initially 16,000) with M5 holding
   camera layers on `l` and protecting audio and screen. Single-encoding video
   that cannot be lowered is paused or refused. A standby drains only while a
   primary is healthy with room. `Fleet.Place` also counts the Episodes it has
   placed on a node since that node's last probe against the node's remaining
   new-Episode room, so concurrent creations cannot all pin to the last slot;
   the SFU's own atomic admission stays the final authority.
4. **Whole-Episode recovery.** When a bound node is lost or returns with a new
   boot incarnation, the Episode moves through one durable, generation-fenced
   transition: the SFU reserves the Episode's complete admitted shape atomically
   (a new reserve operation), then participants rejoin with fresh generations and
   M3 consent rules. A node refusing the reserve gives an explicit capacity
   outcome and never a half-recovered call. Responses from a replaced
   incarnation are rejected, and cleanup keeps targeting the old allocation. On a
   single-node pool the same transition is restart recovery on the same node.
5. **Fault and proof harness.** Scripts create and delete the bench pair, run the
   fault cases below against real SFU processes and the real API adapter, count
   in/out packets, CPU steal, queues and RSS per SKU, and end by listing
   Droplets and failing if any `chalk-sfu-bench` remains.
6. **Capacity proof (needs M10 and M6).** The full admitted workload on a single
   `s-2vcpu-2gb` node with capture, repair and the rare-call stress case. The
   design's initial-budget failures get a reviewed capacity or quality policy; a
   standby or Cloudflare route is not a primary proof.

**Check:** packages 1–5 are proved with real processes and no mock of the SFU:

- Placement. Concurrent Episode creation against a pool one Episode from full
  never over-admits. Primary full, unhealthy and draining each send new
  Episodes to the standby and to nothing else. Overflow lands on Cloudflare
  before the binding commits, records its reason, and stays pinned. With overflow
  off the result is capacity/retry. A refused join in a bound Episode never goes
  to another provider.
- Drain. A one-hour drain on the primary: existing calls and recordings finish
  uninterrupted, new Episodes go to the standby or overflow, refusals are counted,
  restart happens at zero allocations and debt. A forced deadline is reported as
  disruptive. Recovery of the primary restores preferred placement without moving
  a live call.
- Failure, on the bench pair. Kill the primary, partition control, return the old
  node, expire leases, crash during replacement, and saturate the standby. Admitted
  whole calls recover rendered media within M7's bound with no consent or
  privacy failure, double reservation or stale publication; excess demand gets the
  explicit outcome. The standby admits exactly what its 16,000 budget allows at the
  current reservation costs (two three-person, two-camera Episodes; three with one
  camera each), and the next is refused. Six realistic classes fit only after a
  reviewed degraded reservation profile lowers their reservation, and the rare ten-person call is held low or paused under its
  ceiling. Capture runs separately and asserts its reduced envelope.
- Each run repeats with overflow off to prove post-M13 behavior.

Package 6 passes only with measured numbers per SKU (in/out/repair, layers,
CPU/steal, queues, RSS, capture cost, accepted and refused demand). Real
`sgp1` proofs run on the bench Droplets or the production node before cutover,
never on the Air.

**Rollback:** every package is additive. Overflow, roles and drain control sit
behind configuration; a one-node pool with overflow on behaves as today. The
binding gains optional fields only, so the previous release still reads it.
Bench Droplets are deleted by tag; nothing in production changes until the SFU
lead deploys.

**Needs the owner:** nothing in this plan. A production standby, a larger primary
or an always-on second node is a money decision and is not assumed.

**Risk:** a single production node means a lost node is an outage for its live
calls until it is rebuilt. This plan makes that outcome explicit and bounded
instead of hiding it, and does not claim redundancy. Calling the bench-proved
standby role "production failover" would be false while production has one node.

## M12 — Full cutover, cohort sunset and monitoring parity

**Dependencies:** rollout requires M1–M8, M10 and M11 packages 1–6, with package 5's fault proofs passing. The
inventory, SDK version policy, monitoring and dashboards start now and run in
parallel. M9 is optional. Production deploys and the flag flips belong to the SFU
lead.

**Work packages**

1. **Inventory and counts (starts now).** One audited query set counts Tenants,
   Spaces, explicit Cloudflare overrides, tenant-managed provider configuration,
   inactive settings and live bindings by provider, plus recording and
   transcription dependencies. Output is sanitized counts only.
2. **Client release and sunset (starts now).** Release compatible browser/shared
   SDKs, React Native SDKs and first-party apps before selection changes.
   Inventory old releases, set a bounded upgrade window and minimum version, and
   return an actionable upgrade response at sunset. Never send an unknown grant to
   an old decoder, and keep no indefinite Cloudflare cohort.
3. **Monitoring parity (starts now).** Provider-aware client stats, rendered-media
   and listener-heal evidence, API/SFU/capture failure alarms, latency/loss/freeze,
   packet admission, node health/drain/repair, and TURN credential and relay
   alarms independent of SFU selection. Update the journey ledger, event contract
   and observability proof when lifecycle boundaries change.
   Preserve trace/session/operation context through retries and cleanup, and keep
   secrets, SDP, IPs and media out of telemetry.

   **One benchmark on every ship (scorecard parity).** Today only
   `sfu.loopback.pass` and `sfu.impairment.pass` gate for `chalk_sfu` in
   `perf/budgets.json`; the `chalk_sfu` and `cf_sfu` action budgets and
   `proof.leave_median_ms` are `gate:false`, and join startup, loss, stalls,
   admission refusals, load and `device.*` have no budget. This work adds budgets
   for join startup, Leave, mic/camera toggles, stalls, `sfu.loss_pct`, admission
   refusals, load metrics and the `device.*` scenarios (reconnect, network
   switch, relay/TURN, real browser, phone). A metric nothing emits yet gets one
   emitter issue, not a budget. A deterministic budget gates from its first
   commit. A noisy budget flips to `gate:true` in its own PR, only after 7
   nightly values from at least 3 different nights whose spread is below
   `tolerancePct`; the 18 `chalk_sfu` action-latency flips are one such PR
   (earliest around 15 November). `cf_sfu` action budgets stay warn-only and M13
   deletes them. This is the M7 scorecard follow-up and finishes here.

4. **Cutover.** Expand the flag through internal canary, cohorts, and then flip
   the deployment and all Tenant/Space defaults to `chalk_sfu`, including
   explicit overrides. New Tenants and Spaces inherit it. Existing Episodes stay
   pinned until they finish or an authority replaces them. Cloudflare SFU stays
   only as rollback through M13. When counts show every Tenant and Space on the
   own provider and the last compatible-client check passes, and once production
   has a node configured, the Promote real-call proof also runs on `chalk_sfu`
   (join startup, Leave, mic/camera toggle) and the scorecard scoring fails the
   Promote run on regression (rollback stays safe), set
   `CHALK_SFU_CLOUDFLARE_OVERFLOW` off; that moment starts M13's window.
5. **Rollback rehearsal.** Default-on rollback: new Episodes return to Cloudflare,
   pinned live Episodes do not drift, explicit replacement and cleanup succeed.

**Check:** audit counts show every Tenant and Space resolves to the own provider
for new Episodes, and live bindings and traffic counts agree with the flag. Each
supported browser and real iOS and Android builds pass join, refresh,
restart/replacement, every source, relay-only paths and recording/transcription.
Unsupported versions get the upgrade response. Matched peak cohorts compare
success, rendered latency/freezes, recovery and capacity under M6/M7 gates.
Injected API, SFU, TURN, capture and cleanup faults fire their alarms with
journey correlation. Publish sanitized counts and proof, no Tenant identifiers
or private queries.

**Rollback:** the flag returns new Episodes to Cloudflare; pinned calls finish
where they are. Rehearsed in package 5 before the flip is called complete.

**Needs the owner:** the production flag flips and deploys are routine for the
SFU lead. A minimum-client-version cutoff date that shuts out real users is
direction and needs the owner's date.

**Risk:** flipping only a process default leaves explicit Space selectors, old app
installs, capture and vendor-specific support queries behind. Counts of bindings
and actual traffic, not a checked flag, prove full cutover.

## M13 — Cloudflare SFU retirement and removal

**Dependencies:** M12 is complete and overflow is off. Keep the tested Cloudflare
rollback release and credentials until every criterion below passes. This is
separate from TURN.

**Work packages**

1. **TURN extraction (starts now, no behavior change).** Move Cloudflare TURN/STUN,
   its minter and least-privilege credentials out of the SFU adapter package so
   deleting the adapter cannot remove them. The native WebRTC binding stays unless
   the audit shows it unused.
2. **Observation window.** Starts when M12 package 4 finishes. It lasts **7
   consecutive days**, including at least two evening peaks and one matched
   synthetic peak, with every Tenant, Space and supported client cohort on the
   own provider. The earlier 30-day figure assumed busy traffic; Chalk has no
   active users, so a calendar window would add waiting and no evidence. The
   window extends until the criteria hold, and the owner can lengthen it.
   Require no unresolved privacy, media, recording or capacity regression,
   passing M11 capacity and drain proofs, zero Cloudflare overflow including
   during deploy and failure drills, zero Cloudflare SFU signaling, and at its end
   zero Cloudflare SFU Episodes, capture connections, queued retries, cleanup
   intents or unsupported legacy-client demand. Rehearse rollback before it closes.
   Do not infer retirement from low billed egress.
3. **Removal.** Delete the Cloudflare SFU adapter, runtime SFU credentials and
   configuration, provider-selection and SDK branches, obsolete fixtures,
   vendor-only monitoring and the overflow switch. Keep readers for historical
   bindings and recording artifacts until retention ends, and no destructive
   change breaks the previous release.

**Check:** own-SFU browser/native calls, recording/transcription and relay-only
calls pass with Cloudflare **SFU** credentials absent and outbound SFU API access
blocked. TURN still mints and renews credentials and relays media. Old binding
and artifact reads, schema compatibility, `pnpm run regen`,
`pnpm run check:generated`, targeted gates, and a search for live vendor SFU calls
pass. Record the window and the remaining TURN dependency.

**Rollback:** package 1 reverts by itself. Before package 3, the flag returns new
Episodes to Cloudflare. After package 3 the flag is gone: recovery means
redeploying the retained compatible release, which is why package 3 ships as an
explicit retirement release with that release named in the PR.

**Needs the owner:** the retirement release is the point of no flag rollback;
the SFU lead records the owner's go before package 3 merges. The window length
above is a decision made here, open to the owner's change.

**Risk:** removing a shared token or the native WebRTC dependency can break TURN
or supported clients; package 1 exists to prevent that.

## Lane boundaries

M1 fixes the wire contract/harness. **M2, M4 and M8 are active lanes:** M2 owns
API/shared-SDK provider wiring, configurable admission and initial node binding;
M4 owns SFU layer routing; M8 owns provider-neutral visible-tile subscriptions.
The full-replacement goal changes their limits and completion wording, not their
ownership. M2 does not absorb fleet failover or recording, and M8 stays independent
of SFU milestones and can ship against Cloudflare now.

M3 follows M2's authority seams. M5 follows M3/M4 and alone owns shared feedback,
pacing/allocation wiring. M6 follows M2–M5; M7 follows M6. M9 follows M3–M5 and
can run beside M6/M7; it is not required to certify baseline capacity.

After M2, **M10 capture and M11 fleet operations can run in parallel**, coordinating
capture resource costs, node binding and protocol changes. M10's final proof
waits for M3–M6; M11's final peak/drain proof waits for M6 and M10. M12's client
inventory and monitoring work can run alongside them, but full rollout waits for
M1–M8/M10/M11. The primary proof is on the $18 size; standby drain and failover are proved on bench Droplets,
with reduced admission and explicit refusal/temporary-overflow outcomes. Production runs one node. M13 starts its observation window only after M12 completes.

Coordinate `protocol/`, generated contracts, Episode bindings and shared SDK
changes with their owning lane. Use the existing authority/capture pipeline;
do not let parallel lanes create competing wire shapes or placement records.
