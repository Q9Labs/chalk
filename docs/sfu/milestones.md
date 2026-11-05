# SFU implementation milestones

Each milestone is a mergeable unit, split into focused PRs when needed. M1–M7
prove an internal canary, not the finished replacement. Full cutover requires
M1–M8, M10 and M11; M12 moves every Tenant and Space; M13 retires Cloudflare SFU.
M9 remains an optional efficiency improvement. The migration flag starts off and
becomes default-on in M12. [Design](design.md) owns the contracts, capacity gates
and temporary exclusions. These docs do not authorize provisioning or rollout.

Run heavy Linux/browser/load checks on Instabox. Real `sgp1` capacity proofs run
on production-size Basic `s-2vcpu-2gb` nodes, not the Air. Production targets one $18
`s-2vcpu-2gb` primary and one $6 `s-1vcpu-1gb` degraded standby, $24/month.
Primary proves the full admitted peak; standby proves its smaller envelope. Create staging only for test runs
and destroy it afterwards. The design explicitly identifies workload combinations
that do not fit the initial 32,000-packet reservation budget; a passing canary
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
time, while a Cloudflare-provider session still requests `h` first. Constrain a
subscriber below the lowest layer: it goes audio-only with the paused-video state,
no repull occurs through a pause lasting past the seven-second stall window, and
video returns only after the estimate holds. A ten-person all-high call with a
screen share stays at or below 11,520 ingress-plus-egress packets/s, including
repair. Also test the configured 16-Participant maximum and mandatory-media admission:
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

## M6 — Reproducible sgp1 staging and capacity proof

**Scope:** add a DO `sgp1` SFU deployment module and managed runtime integration,
host/cloud firewalls, certificate rotation, private telemetry and single-node
drain/rollback controls. Use disposable `s-1vcpu-1gb` nodes for functional checks
and disposable `s-2vcpu-2gb` nodes for capacity, with runtime settings from the
[design](design.md#memory-budget). Production uses the $18 primary and $6
standby; primary-first placement and degraded failover belong to M11. Reuse Cloudflare TURN and prove relay
to our SFU. Destroy staging after each run; do not retain a $6 monthly node.

Before staging, set the host and socket receive buffer to 8 MiB, report the
effective size, and drain/cap unread layer buffers from the
[#810 follow-up](https://github.com/Q9Labs/chalk/issues/810#issuecomment-6658828184).
Measure the finished M5 feature set against the
[M1 evidence](design.md#measured-m1-capacity), including the estimated 15 to 30%
CPU overhead, instead of treating M1 throughput as a finished-SFU guarantee.
Profile each load on the production SKU. A profile-justified optimization or Pion
fork patch is a separate PR; M7 waits only if it fixes a failed budget.

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

Run hour-long tests on a production-size node for 10 and 12 three-person
Episodes with two cameras, 65% screen duty and an all-screens-on burst. Run a
ten-person sparse-camera call, its capped all-high case, and a 16-person ceiling
case with admission refusal or a validated higher ceiling. Also run twelve
classes plus the rare call and the all-camera stress
case, even if initial admission refuses them. Report refusals and quality loss,
not just admitted-call throughput. This distinguishes the measured workload,
supported admission envelope and unsupported raw worst case.

Record actual ingress/egress/repair packets, admitted reservations, forwarded
sources, rendered resolution, CPU, steal, GC, scheduler/pacer delay, peak RSS and
transfer. Keep the initial 16,000/32,000 budgets unless complete measurements
justify a reviewed calibration; never silently change units or use M8/M9 savings
to hide missing baseline capacity. Require below 70% total RAM, no growing
buffers, no receive-buffer drops, bounded repair/queues and no unexplained media
loss. Repeat in evening-to-night Pakistan/Dubai windows and report the spread.
Investigate the roughly 60,000 outbound-packet ceiling before claiming capacity
above it. Capture profiles privately and publish sanitized summaries only.

For low latency, compare rendered end-to-end p50/p95 and freeze rate with a
matched Cloudflare cohort at the same load, codec and network. Require no p95
latency or sustained freeze regression; report SFU processing/queue delay apart
from encode and network latency. Keep M7's join/recovery thresholds as separate
gates. Starve CPU and expire TURN credentials to prove admission guards, renewal,
alerts and bounded recovery. Rehearse CPU/RAM-only resize up/down after full
drain, without growing disk, and verify teardown leaves no test nodes running.

**Risk:** shared CPU and generator limits can distort one run. Staging's one
vCPU cannot certify production. Full cutover waits for M10's capture demand on primary and M11's
degraded-standby drain/failover proof; the $6 node need not pass the full primary
peak or all-high reservations. If
relay, native interop, consent, recovery or capacity evidence is absent, keep the
migration flag off for affected cohorts.

## M7 — Internal canary and rollback rehearsal

**Scope:** make the default-off allowlist configurable for internal Spaces after
M1–M6 are green; preserve Cloudflare elsewhere during migration. This is an
intermediate proof, not the final adoption boundary. Add cohort dashboards and
automated canary checks. Rollout is an operational step after this PR, not an
automatic consequence of merging it. Keep both adapters installed.

**Files:** provider selection/runtime configuration, proof scripts, observability
queries and public rollout/rollback guide. Private allowlists live outside Git.

**Check:** at least 20 scripted joins and 10 fault/recovery trials per provider
under matched network/call shape; zero cross-Tenant or mute/consent failures,
all stable-network joins render audio/video within 10 seconds, and all short
transport faults recover rendered media within 15 seconds after network restore
without manual toggles. Long-drop cases intentionally remain off pending fresh
consent. These are initial acceptance thresholds, not statistical SLO claims.
Then run internal usage for seven days with no unresolved privacy/authority
failures or persistent listener-unpulled alarm and within M6 capacity limits.
Rehearse flag rollback: new Episode uses Cloudflare, live own-SFU Episode stays
pinned, explicit rejoin recovers a killed node and outstanding cleanup drains.

**Risk:** a one-node canary can lose all own-SFU calls until replacement. That
is acceptable only for this internal proof. M11 supplies primary-first placement,
degraded standby admission and drain/failure proof, and M12 supplies recording/client/monitoring parity
for full rollout. Selector rollback is not live-session migration; removing an
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

**Dependencies:** start after M2 records a node in the Episode binding. Use M3's
generation/source fences, M5 budgets and M6 capacity evidence. Build in parallel
with M10; final capacity acceptance includes M10 capture.

**Scope:** operate one **$18 `s-2vcpu-2gb` primary** and one **$6 `s-1vcpu-1gb`
standby**, $24/month total. New Episodes use primary unless it is unhealthy,
draining or full. Only then try standby in degraded mode: M5 holds camera layers
low, protects audio/screen, bounds repair/queues and refuses admission at
**16,000**, versus primary's **32,000** initial budget. This is not equal-node
load balancing or full-capacity redundancy. Single-encoding video cannot be
made lower-resolution by RID selection; pause/refuse it when necessary.

Keep each Episode on one node. Route joins, signaling, leases, capture and
cleanup by its durable binding and boot incarnation. Primary failure uses
fresh, generation-fenced allocations on standby within the degraded envelope,
not seamless transport migration. Atomically reserve complete recovering
Episodes from their known shape, avoiding half-recovered calls that consume
capacity through individual retry races. When primary recovers, new Episodes
prefer it; existing standby Episodes remain pinned until they end.

At the initial costs, standby fits **six three-person Episodes** at 14,400,
not seven at 16,800, or one capped ten-person Episode plus one three-person
Episode at 13,920. Six realistic screen-on classes held on `l` use about 10,620
actual packets/s before repair/capture. It carries realistic admitted traffic, not the
twelve-class 28,800 reservation or the all-high peak. M5 low-layer savings do
not automatically lower M2 reservations. A wider degraded envelope needs
measured, enforced reservation calibration; capture consumes capacity too.

**Decision until M13:** if standby also refuses a new Episode, overflow
to Cloudflare SFU before persisting its provider binding. Record the reason and
keep overflow Episodes pinned. This is migration policy, not an indefinite
Cloudflare exception. Never send a refused join in
an existing own-SFU Episode alone to Cloudflare. Return capacity/retry, or use
an explicit whole-call rollback with an authority-approved new Episode.
M13 removes overflow; afterwards smaller-standby refusals are explicit degraded
service, not hidden Cloudflare calls.

For primary deploys, drain without taking new Episodes, keep current calls and
recordings running to completion, then restart only at zero allocations and
cleanup debt. New calls use standby's bounded capacity and, if adopted, temporary
overflow. This preserves existing media, not full new-call availability during
drain. A forced deadline causes explicit replacement and must not be called
zero-interruption. Drain standby only with a healthy primary.

**Files:** provider/node registry, Episode binding persistence and routing,
SFU health/drain/degraded controls, admission, infrastructure/runtime composition,
public deploy/recovery guidance, fault/proof scripts and correlated telemetry.
The binding starts in M2; extend it without a competing model.

**Check:** first prove the complete admitted primary workload on the $18 node
alone, including M10 capture, M5 repair and the overlapping rare-call stress
case. Resolve the design's initial-budget failures with measured, reviewed
capacity/quality policy; a standby or Cloudflare route is not a primary proof.
No second $18 node or larger SKU is authorized by this plan.

Then prove drain and failure **onto the $6 node**, not another $18 node. Test
six realistic three-person Episodes without capture, a seventh refusal, and the rare ten-person
case with all-high demand held low/paused under its Episode ceiling. Include
capture in a separate run and assert its reduced admission envelope. Include
single-encoding publishers, primary full/unhealthy/draining triggers,
standby saturation, concurrent placement, control partition, old-node return,
lease expiry, crash during replacement and cleanup debt. Admitted whole calls
recover rendered media within M7's bound without consent/privacy failures,
double reservations or stale publication. Excess demand returns the explicit
outcome, with Cloudflare overflow tested for new Episodes only.

Run an hour-long primary drain: existing calls/recordings finish uninterrupted,
new Episodes go only to degraded standby or approved overflow, and all refusals
are counted. Force a deadline to distinguish disruptive replacement. Show
primary recovery restores preferred new-Episode placement without moving live
standby/Cloudflare calls. Report actual in/out/repair, layers/quality, CPU/steal,
queues, RSS, capture cost, accepted calls and refused/overflowed demand for each
SKU. Repeat with overflow disabled to prove post-M13 behavior.

**Risk:** the $6 standby cannot carry the full all-high reservation at peak.
Calling it redundant without showing reduced capacity hides join refusals.
Overflow before pinning, whole-Episode recovery and bounded admission prevent
provider drift and overload from turning primary failure into a fleet failure.

## M12 — Full cutover, cohort sunset and monitoring parity

**Dependencies:** rollout requires M1–M8, M10 and M11. Inventory, client release
planning and dashboards can start sooner in parallel. M9 is optional.

**Scope:** move every Tenant and Space to the own SFU, including explicit
Cloudflare overrides, tenant-managed provider configuration and
recording/transcription dependencies. Release compatible browser/shared SDKs,
React Native SDKs and first-party apps before selection changes. Inventory old
SDK and native releases, set a bounded upgrade window/minimum version, measure
remaining demand and enforce an explicit upgrade requirement at sunset. Do not
keep an indefinite Cloudflare cohort or send an unknown grant to an old decoder.

Expand the migration flag through canary/cohorts, then flip the deployment and
all Tenant/Space defaults to `chalk_sfu`. New Tenants/Spaces inherit it; existing
Episodes stay pinned until completion or explicit authority-controlled
replacement. Retain Cloudflare SFU only as rollback through M13. Include TURN
credentials/renewal and relay alarms independently of SFU selection.

Finish monitoring parity: provider-aware client stats, rendered-media and
listener-heal evidence, API/SFU/capture failures, latency/loss/freeze, packet
admission, node health/drain/repair and actionable alerts. Update the existing
journey ledger, event contract and executable observability proofs when lifecycle
boundaries change. Preserve trace/session/operation context through retries and
cleanup, and keep secrets/SDP/IPs/media out of public evidence and telemetry.

**Files:** provider selection/runtime configuration, shared/native SDK version
policy, first-party consumers, public upgrade guidance and cutover/proof scripts;
`docs/observability.md`, `contract/webhooks/v1/journey-events.json`, API
observability and `infrastructure/observability/production-alerts/` as needed.

**Check:** audit counts prove all Tenants/Spaces, including inactive settings,
resolve to the own provider for new Episodes. Test each supported browser and
real iOS/Android cohort for join, refresh, restart/replacement, all supported
sources, relay-only paths and recording/transcription. Verify unsupported
versions get an actionable upgrade response and no residual Cloudflare exception.
Compare matched peak cohorts for success, rendered latency/freezes, recovery and
capacity using M6/M7 gates. Inject API, SFU, TURN, capture and cleanup faults and
assert their alarms and journey correlation actually fire. Rehearse default-on
rollback: new Episodes return to Cloudflare, pinned live Episodes do not drift,
and explicit replacement/cleanup succeeds. Publish sanitized counts and proof,
not Tenant identifiers, private queries or customer runbooks.

**Risk:** flipping only a process default leaves explicit Space selectors,
old app installs, capture and vendor-specific support queries behind. Counts of
bindings and actual traffic, not a checked flag, prove full cutover.

## M13 — Cloudflare SFU retirement and removal

**Dependencies:** M12 is complete. Retain the tested Cloudflare rollback release
and credentials until every criterion below passes. This is separate from TURN.

**Scope and retirement criteria:** observe at least **30 consecutive days** after
full cutover, including busy evening peaks, with every Tenant/Space and supported
client cohort using the own provider. Require no unresolved privacy, media,
recording or primary-capacity regressions, passing full-primary single-node
proofs and passing degraded-standby drain/failure proofs with documented
refusals. Require zero Cloudflare overflow, including during deployment/failure
drills, throughout the window. Require zero Cloudflare SFU signaling throughout
the window and zero
remaining Cloudflare SFU Episodes, capture connections, queued retries, cleanup
intents or unsupported legacy-client demand at its end. Rehearse the rollback
path before closing the window. Do not infer retirement from low billed egress.

Then remove the Cloudflare SFU adapter, runtime SFU credentials/config,
provider-selection/SDK branches, obsolete fixtures and vendor-only monitoring.
Migrate or retain readers for historical bindings and recording artifacts until
their retention obligations end; no destructive removal that breaks the previous
release. Keep Cloudflare TURN/STUN, its minter, least-privilege credentials and
renewal/relay monitoring. A dependency called Cloudflare, such as the native
WebRTC binding, stays unless the audited SFU removal actually makes it unused.

**Files:** Cloudflare SFU adapter and composition, contracts/generated clients,
provider configuration, old tests/fixtures and public docs. TURN can move out of
the SFU adapter package if needed; do not delete it with the adapter.

**Check:** own-SFU browser/native calls, recording/transcription and relay-only
calls pass with Cloudflare **SFU** credentials absent and outbound SFU API access
blocked. TURN still mints/renews credentials and relays media. Check old binding
and artifact reads, schema compatibility, `pnpm run regen`,
`pnpm run check:generated`, targeted gates and a search for live vendor SFU calls.
Record the observation window and remaining independent TURN dependency.

**Risk:** after removal, flag rollback is gone; recovery to Cloudflare requires
redeploying the retained compatible release. Treat that as an explicit retirement
release decision, not automatic cleanup after a canary. Removing a shared token
or native WebRTC dependency can break TURN or supported clients.

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
M1–M8/M10/M11. The primary proof is on $18; standby drain/failover is on $6,
with reduced admission and explicit refusal/temporary-overflow outcomes. M13 starts its observation window only after M12 completes.

Coordinate `protocol/`, generated contracts, Episode bindings and shared SDK
changes with their owning lane. Use the existing authority/capture pipeline;
do not let parallel lanes create competing wire shapes or placement records.
