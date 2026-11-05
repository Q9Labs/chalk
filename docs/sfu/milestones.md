# SFU implementation milestones

Each row below is one mergeable, disabled-by-default PR. The service and adapter
are not production-ready until all seven checks pass. [Design](design.md) owns
the contract, budgets and exclusions. Run heavy Linux/browser/load checks on
Instabox; the sgp1 capacity proof runs on the target class of Droplet, not the Air.

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
admission cap and node admission budget. Advertise capability fields but leave
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
Verify ninth admission rejection, capture exclusion, old/new SDK discrimination,
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
state for M5. Attribute any borrowed LiveKit units. Keep adaptation capability
false until feedback and pacing work.

**Files:** SFU RTP routing/layer modules and tests; the planned **THIRD_PARTY_NOTICES.md**;
shared API adapter conformance cases; SDK capability type/decoder if needed.

**Check:** one real two-RID publisher and two subscribers request opposite
layers; both decode. Switch repeatedly under keyframe delay, sequence wrap and
packet reorder; identity stays stable and output has no sequence discontinuity
that defeats decoding. Pause `h`, then `l`, then test a publisher with no RIDs:
the remaining valid stream flows. Test `asciibetical` ordering and per-track
errors. Chromium/Firefox/WebKit interop runs in M6, not a fake peer claim here.

**Risk:** selecting an SSRC is not sufficient for decoder continuity. LiveKit
code may depend on its own RTP buffers, clock types or Pion fork.

## M5 — Congestion control, retransmission and observability

**Scope:** wire ingress TWCC, per-subscriber GCC feedback, transport sequence
rewriting, pacing, bounded NACK/RTX caches and audio-first allocation. Enable
`serverLayerAdaptation` only for the own provider; treat SDK layer requests as
ceilings and keep the Cloudflare behavior unchanged. Add bounded operational
telemetry and client-stat provider correlation; document alarms and journey
evidence. Pin buffer/retransmission limits in configuration, not unbounded maps.

**Files:** SFU interceptor/pacer/allocator modules; SDK capability consumption and
call-stats schemas as needed; API stats allowlists; `docs/observability.md`,
journey ledger/proof definitions for changed lifecycle boundaries.

**Check:** reproducible network impairment harness with a real receiver:
constrain only one subscriber, assert it drops quality while the other stays
high, microphone packets/rendering continue, and quality rises after recovery.
Inject loss on each leg and assert actual NACK plus RTX packets and decoder
recovery, with repair memory/rate bounded. Verify requested/effective RID,
feedback age, queue delay and correlated failure evidence; scan exported logs
for forbidden SDP, IPs, secrets and payloads. Require a real rendered-media
assertion in M6, not just bytes emitted by the SFU.

**Risk:** duplicated TWCC sequence spaces, unlimited retransmits and competing
SDK/server upswitch loops can worsen congestion. Missing audio TWCC support
must not cause audio starvation; retain an audio budget and conservative fallback.

## M6 — Reproducible sgp1 staging and capacity proof

**Scope:** add a DO sgp1 SFU deployment module and managed runtime integration,
host/cloud firewalls, certificate rotation, private telemetry, drain and rollback
commands. Reuse Cloudflare TURN, proving relay to our SFU. Deploy only staging;
use a temporary production-class `c-4` for its load proof, with resource cleanup.
Document the exact SKU, workload and resulting safe admission limit.

**Files:** `features/media/infra/`, environment composition under
`infrastructure/`, SFU image/runtime configuration, browser/network proof scripts,
and public operational guidance without real addresses or credentials.

**Check:** supported browser and native peers make real API/Postgres/Sync calls
with rendered audio/video and screen audio. Include Chrome-like two-RID,
Firefox single-layer and WebKit behavior, delayed publication propagation,
re-pull after a missing subscription, Wi-Fi/mobile-style path change, 60-second
offline, SFU process kill and restart, and an outbound-TCP-443-only relay call.
Replay #761 off-reason proof against candidate and supported prior SDK sockets.
Run at least 30 minutes on the actual production SKU for one eight-person call
and six four-person calls separately, including all-high and screen profiles.
Use known packet/media input and record actual forwarded streams, packet rate,
CPU/GC, peak memory, egress, RTX and queue delay. Pass only inside design budgets;
lower caps on failure. Report limits and repeatability, not an invented streams/vCPU
benchmark. Staging's shared CPU result cannot certify production capacity.

**Risk:** Cloudflare TURN routing/billing differs with an external SFU; regional
stock and shared transfer allowance vary. No flag enable if relay, native interop,
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

## Lane boundaries

M1 fixes the service wire contract and harness first. Once it lands, M2 can own
API/SDK wiring while M4 owns SFU layer routing. M3 follows M2's authority/provider
seams. M5 follows M3/M4 and is the only owner of shared feedback/allocation
wiring. M6 depends on M2–M5; M7 depends on M6. Coordinate changes to `protocol/`
through its owning milestone; do not have lanes independently invent wire shapes.
