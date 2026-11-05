# SFU implementation milestones

Each section below is one mergeable, disabled-by-default PR. The service and
adapter are not production-ready until the seven checks of M1–M7 pass. M8 and M9
are quality optimizations and not canary prerequisites. [Design](design.md) owns the contract, budgets and exclusions. Run
heavy Linux/browser/load checks on Instabox; the sgp1 capacity proof runs on the
production Droplet size (Basic `s-2vcpu-2gb`), not the Air.

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
route flow. Persist provider/application binding at Episode creation and resolve
all subsequent operations from it, including refresh, cleanup and recorder
exclusion. Add the default-off Tenant/Space selector, eight-Participant own-provider
admission cap and the node admission budget: each Episode is reserved at its
supported peak (all remote cameras on `h`, microphones, one screen share), a join
that would exceed the node's packet budget is refused, and one active screen share
per Episode is allowed (see [Hosting and budget](design.md#hosting-and-budget)). Advertise capability fields but leave
server adaptation/ICE restart false until their milestones pass. Reject capture
before reserving work. Old providers and old SDK cohorts stay on Cloudflare.

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
Verify ninth admission rejection, join refusal at the packet budget, a second
concurrent screen share refused, capture exclusion, old/new SDK discrimination,
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
Hold each Episode to its packet ceiling (the lower of its supported peak and
11,520 packets/s) by lowering non-speaker tile layers first. Pause video and keep
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
video returns only after the estimate holds. An eight-person all-high call with a
screen share stays at or below 11,520 packets/s. Inject loss on each leg and
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

**Scope:** add a DO sgp1 SFU deployment module and managed runtime integration,
host/cloud firewalls, certificate rotation, private telemetry, drain and rollback
commands. Size staging at Basic `s-1vcpu-1gb` and production at Basic
`s-2vcpu-2gb`, with `GOMAXPROCS`, `GOMEMLIMIT` and `GOGC` set for each from the
[design](design.md#efficiency-on-a-small-machine). Reuse Cloudflare TURN, proving
relay to our SFU. Deploy staging. Run the capacity proof on a Droplet of the
production size created by the same module, drained and not selectable until M7;
there is no temporary larger SKU. Capture CPU and heap profiles under each load
profile. Document the exact SKU, workload, measured cost per packet and resulting
safe admission limit. Each profile-justified optimization or Pion fork patch from
the design lands as its own later PR with before and after profiles; M7 waits for
them only if the measured capacity misses the planned budget.

**Files:** `features/media/infra/`, environment composition under
`infrastructure/`, SFU image/runtime configuration, browser/network proof scripts,
and public operational guidance without real addresses or credentials.

**Check:** supported browser and native peers make real API/Postgres/Sync calls
with rendered audio/video and screen audio. Include Chrome-like two-RID,
Firefox single-layer and WebKit behavior, delayed publication propagation,
re-pull after a missing subscription, Wi-Fi/mobile-style path change, 60-second
offline, SFU process kill and restart, and an outbound-TCP-443-only relay call.
Replay #761 off-reason proof against candidate and supported prior SDK sockets.
Run at least 30 minutes on the production-size Droplet, separately, for: one
eight-person all-high call with a screen share, held to its 11,520 ceiling; that
call plus one four-person all-high call with a screen share; and three four-person
all-high calls with screen shares while a fourth Episode's second join is
refused. Also run two eight-person calls and assert the second is refused as it
grows. Use known packet/media
input and record actual forwarded streams, packet rate, CPU, steal, GC, peak
memory, egress, RTX and queue delay. Pass only inside the design budgets
(20,000 packets/s reserved at supported peak, 16 Participants, memory with
headroom); lower caps on failure.
Replace the 25 µs per packet and 2 MiB per PeerConnection guesses with the
measured values in the design. Starve the CPU (more busy workers than vCPUs):
queue delay rises and admission refuses new Episodes while live calls continue.
Rehearse a CPU-and-RAM resize up and down on staging, record downtime and whether
the public address and firewall rules survive, and confirm the Droplet's
disk stays unchanged. Report limits and repeatability, not an invented
streams/vCPU benchmark. Staging's single shared vCPU cannot certify production
capacity; production-size results decide the limit.

**Risk:** shared CPUs can steal time, so a run that passes once may not repeat;
repeat the long runs at different hours and report the spread. Cloudflare TURN
routing/billing differs with an external SFU; regional stock and shared transfer
allowance vary. No flag enable if relay, native interop,
moderation, loss recovery or resource-bound proofs are missing.

## M7 — Internal canary and rollback rehearsal

**Scope:** make the default-off allowlist configurable for internal Spaces after
M1–M6 are green; preserve Cloudflare everywhere else. Add cohort dashboards and
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

**Risk:** the canary runs on one node, so node loss ends every own-SFU call
until Participants rejoin. That is accepted for internal Spaces only; general
rollout needs a second node. Selector rollback is not live-session migration; removing the old
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

## Lane boundaries

M1 fixes the service wire contract and harness first. Once it lands, M2 can own
API/SDK wiring while M4 owns SFU layer routing. M3 follows M2's authority/provider
seams. M5 follows M3/M4 and is the only owner of shared feedback/allocation
wiring. M6 depends on M2–M5; M7 depends on M6. M8 is independent and touches only
the SDK, so a lane can take it at any time. M9 depends on M3, M4 and M5 and is not a
prerequisite for M6 or M7. Coordinate changes to `protocol/` through its owning
milestone; do not have lanes independently invent wire shapes.
