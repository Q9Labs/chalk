# Chalk Cloudflare Capture Worker Spec

Status: Draft companion to `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`.

Parent: `scratchpad/chalk-recorder-control-plane-spec-2026-07-13.md`.

Owner: Hasan Shoaib

## Purpose and provider boundary

This spec defines the native selective-capture worker that receives a fenced assignment from Chalk, joins the chosen Cloudflare SFU path, subscribes only to the tracks required by the ratified stage layout, and writes encrypted, immutable capture bundles plus a deterministic media timeline.

Cloudflare is the SFU provider. Pion, if selected, is only the worker's native WebRTC client implementation for ICE, DTLS, SRTP, SDP, RTP, RTCP, codec handling, and track receipt. It is not a replacement SFU.

The canonical launch path is the low-level **Cloudflare Realtime SFU** application ratified by the infrastructure parent. It exposes HTTPS session, track, and renegotiation APIs and has an official Pion example. RealtimeKit remains a transitional product adapter where Chalk still needs it; it is not the recorder transport.

RealtimeKit exposes meetings, participant tokens, managed Core/UI SDKs, and private signaling behavior, but no published Go/Pion native-client contract. The recorder must not reverse-engineer that signaling or treat a RealtimeKit participant token as low-level SFU authority. If product meeting identity still originates in RealtimeKit during migration, Chalk's control plane explicitly bridges it to the separate direct-SFU session and track catalog. RealtimeKit's browser/custom recording application is not a fallback because the launch contract forbids Chromium in the capture plane.

## Non-goals

- The worker does not compose the final meeting video, run the web UI, transcribe audio, infer identity from voice, retain arbitrary gallery tracks, or choose artifact ownership.
- It does not connect to PostgreSQL, KMS, DigitalOcean APIs, or R2 using reusable credentials.
- It does not silently fall back to client-side or Cloudflare-managed recording.
- It does not promise recordings beyond ten participants, 120 minutes, or the selected deterministic stage view.

## Runtime and isolation

Capture runs in SGP1 on CPU-Optimized 2-vCPU/4-GiB DigitalOcean Droplets. Each meeting runs in its own supervised process or container with one job lease and one authority envelope, so a process failure cannot terminate sibling captures. Roots are stateless, outbound-only, immutable by release digest, and operated without routine SSH.

The current capture command and Cloudflare provider port are fixture-only and return `ErrProviderUnimplemented` outside the synthetic path. K0–K4 replace that stub; fixture output cannot satisfy K6 or any staging gate.

The process has bounded CPU, memory, file descriptors, scratch, network, goroutines, and shutdown time. It writes no persistent plaintext media. Temporary codec buffers and key material are memory-only where practical, zeroed or released after bundle commit, and removed during bounded drain.

## Assignment contract

The worker claims through the private mTLS control listener and receives one immutable capture assignment containing:

- protocol, release, job, tenant, session, recording, attempt, fence, lease, trace, and journey identity;
- Cloudflare provider mode, approved signaling endpoint, bounded session authority, ICE servers, token expiry, and reconnect authority;
- authorized participant snapshot with opaque participant ID, display-name snapshot, role, join order, and allowed track classes;
- versioned layout, active-speaker, VAD, overlap, simulcast, bitrate, and degradation policies;
- maximum duration, authority-renewal deadlines, bundle cadence, and expected artifact class;
- control-plane-issued opaque conditional-create object intents stored before assignment, with exact key, method, content type, maximum bytes, expiry, owner reference, attempt, fence, and sequence;
- recording-key authority and authenticated encryption context without KMS credentials;
- heartbeat, progress, terminal, cleanup, and measured-resource reporting requirements.

The assignment never contains reusable Cloudflare, R2, KMS, or infrastructure credentials. A worker cannot change meeting, layout policy, participant identity, output owner, attempt, or fence.

## Cloudflare join and media control

Chalk's control plane owns the direct-SFU application credentials, HTTPS session, and global track catalog. The worker uses Pion to create its peer connection, then sends bounded SDP and track-control requests through the private Chalk control API. The control plane authenticates to Cloudflare's published `/sessions` and track endpoints, returns only the scoped answer or renegotiation result, and records the resulting session/track mapping. The worker requests keyframes through RTCP and closes its scoped session on drain; it never receives the application secret.

The worker joins without captured local microphone or camera media. It subscribes only to:

- every audible Opus track within the ten-participant bound;
- the current screen share at the legibility-qualified layer;
- the active speaker at the qualified stage layer when screen share is not dominant, or a bounded secondary layer while it is dominant;
- low simulcast layers for a deterministic strip of at most six non-primary participants;
- media and control events required to reproduce track, mute, join, leave, reconnect, screen-share, audio-level, and layout state.

Thumbnail layers degrade before screen-share legibility. Total admitted input is budgeted at 4 Mbps per meeting with a 3 Mbps target including audio. An unqualified or unexpected track shape is rejected or degraded by policy; it never expands subscriptions without bound.

## Deterministic timeline and track ownership

Every assignment pins schema and policy versions. Screen share wins the primary stage; simultaneous shares use stable start time then opaque participant ID. Without screen share, the bounded RTP audio-level window and hysteresis select the primary speaker. The strip excludes the primary and orders remaining participants by join time then opaque ID.

The timeline records each policy input and decision on one monotonic clock:

- participant and authorized display-name snapshot;
- track owner, class, codec, simulcast layer, epoch, SSRC and Cloudflare track reference;
- join, leave, publish, unpublish, mute, unmute, replacement, reconnect, and authorization change;
- audio-level samples, VAD decisions, active-speaker changes, overlap intervals, screen-share intervals, and layout decisions;
- media-clock mapping, discontinuity, first decodable keyframe, bundle boundary, gap, and fence generation.

Track identity comes only from authenticated control-plane mapping. Track replacement creates a new epoch tied to the same participant only after the control plane proves the mapping. Voiceprints and acoustic diarization are prohibited.

## Bundle contract

The worker closes an independently verifiable bundle every 10–15 seconds. Track-set changes, authority expiry, drain, or codec discontinuity may close it early. A bundle contains codec-native encoded fragments plus the corresponding versioned timeline slice; it is not a pre-rendered composite.

Each manifest carries recording and job identity, attempt and fence, sequence, object intent, policy versions, codec/layer facts, byte size, checksum, monotonic and media ranges, track epochs, layout-event range, gap facts, and encryption metadata. The schema is versioned and canonicalized before authentication.

Every bundle uses application-layer AES-256-GCM under the independent per-recording data key and authenticated metadata. Upload uses the exact conditional-create intent. The worker reports immutable object facts only after upload and object inspection agree on key, size, checksum, content type, and encryption metadata. It never overwrites a committed bundle or selects a new key on its own.

PostgreSQL stores the normalized manifest index needed for reconciliation: sequence, fence, monotonic/media ranges, track-epoch range, layout-event range, timeline checksum, and immutable bundle reference. The complete timeline slice lives inside the encrypted bundle. Render reconstructs one ordered manifest from the index and verified slices without guessing missing ranges.

## Lease, autonomy, and recovery

The worker heartbeats and reports bounded progress through the private control API. It begins authority renewal when twenty-two minutes remain and must finish before twenty minutes remain. During control-plane loss it keeps the existing SFU session and may write only already authorized bundle keys. It accepts no new job, participant policy, or layout version.

If authority expires first, it closes the current bundle, stops recording, leaves the meeting unrecorded, and later reports `capture_authority_expired` with exact gap bounds. It never continues into an unauthorized buffer.

On process or node loss, committed bundles remain authoritative. The control plane fences the old attempt, revokes its node authority or proves termination, and then assigns a replacement. The replacement rejoins, requests fresh keyframes, creates new track epochs where needed, resumes at the next sequence, and records the observed gap. Frames are never invented to hide discontinuity.

The recovery clock records detection, fencing, replacement assignment, SFU join, track subscription, first decodable keyframe, first committed bundle, and manifest reconciliation. Failure of one meeting process does not restart sibling captures.

## Failure behavior

- Cloudflare join, signaling, ICE, DTLS, track pull, or token failure reports a bounded provider code and closes the current attempt without leaking provider payloads.
- Missing screen share or camera layers degrade according to the pinned policy; missing required audio or identity mapping fails visibly.
- Bundle encryption, scoped upload, inspection, checksum, or conditional-create conflict stops that bundle and triggers retry or terminal failure according to the attempt policy.
- Lease loss, fence mismatch, revoked certificate, or rejected authority renewal stops new media and upload immediately after bounded drain.
- Local disk pressure, memory pressure, CPU saturation, packet loss, keyframe starvation, clock discontinuity, and bundle deadline miss produce explicit metrics and failure facts.

## Observability and security

Journey and W3C trace context propagate from reservation through assignment, SFU join, subscriptions, bundles, replacement, and terminal report. Metrics include join time, ICE/DTLS state, tracks by bounded class, bitrate, packet loss, jitter, keyframe latency, audio-level freshness, bundle duration/bytes/upload time, gaps, reconnects, renewal, CPU, memory, and process outcome.

Logs contain opaque IDs only where necessary and never media, display names, participant tokens, SDP, ICE credentials, object URLs, keys, certificate material, full object keys, or unbounded Cloudflare errors. Crash dumps, snapshots, image layers, telemetry, and scratch contain no plaintext media or key material.

## Implementation phases and ownership

- [ ] **K0 — Direct-SFU compatibility spike:** a minimal Pion client joins the environment-specific Cloudflare Realtime SFU application and receives Opus, camera simulcast, and screen-share tracks using only the published session/track APIs. No RealtimeKit private signaling is used.
- [ ] **K1 — Assignment and schemas:** the control plane returns the complete immutable capture assignment; participant, timeline, track epoch, bundle, gap, and terminal schemas are generated and round-trip tested.
- [ ] **K2 — Native join and selection:** join, subscription, simulcast selection, policy degradation, keyframe requests, and bounded track churn pass deterministic tests.
- [ ] **K3 — Timeline and bundles:** layout, VAD, overlap, clock mapping, encrypted 10–15-second bundles, conditional upload, inspection, and immutable registration pass real-media tests.
- [ ] **K4 — Renewal and replacement:** control loss, process loss, full node loss, revoked certificate, stale fence, reconnect, fresh keyframe, and explicit gap recovery pass.
- [ ] **K5 — Resource and observability proof:** per-meeting isolation, measured two-or-four-meeting density, input budget, redaction, trace continuity, health, and clean drain pass locally. The result selects one qualified density for staging; it does not claim both as fixed constants.
- [ ] **K6 — Staging handoff:** scheduled and unscheduled real Cloudflare recordings produce ordered encrypted bundles and a final reconciled manifest for the render worker.

The main thread owns the shared assignment and schema boundary. Cloudflare research may be delegated as a report; implementation remains in the main thread. Capture implementation waits for the K0 provider decision and control-plane contract freeze. Render may implement against checked-in fixture manifests while capture is built, but staging integration uses real K6 output.

## Done and stopping point

This seam is locally done when K0–K5 pass with supported Cloudflare APIs, the worker runs without Chromium or reusable cloud credentials, real codec-native media produces deterministic encrypted bundles, failure and replacement preserve committed facts and explicit gaps, and its consumer renders the resulting manifest successfully.

The seam is staging-qualified only after K6 and the launch-ceiling capture gates in the staging qualification spec pass. Work stops before production enablement, managed recording fallback, self-hosted SFU work, arbitrary gallery retention, or recordings outside the launch bounds.

## Official Cloudflare references

- `https://developers.cloudflare.com/realtime/sfu/https-api/`
- `https://developers.cloudflare.com/realtime/sfu/sessions-tracks/`
- `https://developers.cloudflare.com/realtime/sfu/example-architecture/`
- `https://github.com/cloudflare/realtime-examples/tree/main/sfu-turn-go`
- `https://developers.cloudflare.com/realtime/realtimekit/concepts/participant/`
- `https://developers.cloudflare.com/realtime/realtimekit/sdk-selection/`
- `https://developers.cloudflare.com/realtime/realtimekit/recording-guide/`

## Open questions

1. Please confirm that “Cloudflare SFU” means the direct Cloudflare Realtime SFU application ratified by the infrastructure spec, with RealtimeKit retained only as a transitional product adapter rather than the recorder's signaling path.
2. Which control-plane component owns the authoritative mapping from Chalk meeting participants to direct-SFU session IDs and track names? K1 cannot pass until this authority is named.
3. What hard per-meeting memory and scratch limits should the SGP1 capture process enforce? K1 must pin them in the release contract before the density proof.
