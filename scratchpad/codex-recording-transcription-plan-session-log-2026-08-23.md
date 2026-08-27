# Recording and transcription planning session

## 2026-08-23: orientation started

Hasan asked for a plan to implement recording and transcription, then asked for full orientation before product decisions. Discovery is read-only and split across product language, SDK/application surfaces, backend lifecycle, and provider/infrastructure lanes.

The first verified finding changes the framing: this is not a greenfield feature. Chalk already has recording control-plane and durable job contracts, capture/render infrastructure definitions, React controls, Transcript APIs, and a private transcription dispatcher. The capability inventory still marks real recorder-pool qualification, capture-to-download proof, recording-to-final-Transcript proof, live captions, and first-party mobile Episode integration as incomplete.

The plan must preserve the canonical model: a Recording and Transcript are immutable Episode-owned Artifacts; Transcription names the process. Core facts stay provider-neutral, Postgres is durable authority, retention is Tenant-configurable, and React/React Native public surfaces must remain structurally equal.

## 2026-08-23: orientation completed

The current implementation has two disconnected recording paths. Sync accepts capability-gated `start_recording` and `stop_recording` commands and sends `recording.start` or `recording.stop` through the API provider bridge, but the only composed `SFUExecutor` returns terminal `unsupported_effect` for both recording effects. Separately, the API owns a full reservation, capture, render, verification, and Artifact pipeline. No verified orchestration connects the Sync recording identity to that pipeline.

Other integration gaps are concrete: the private recorder-worker router exists but is not composed in API startup; recording and Transcript webhook schemas exist but production emitters are absent; generated HTTP contracts exist but the normal `SpaceClient` surface has no Artifact controller or snapshot slice; React recording/transcription controls are internal scaffolding, Transcript panels receive hard-coded empty arrays, and React Native has no Episode Recording or Transcript surface.

The custom compute design is substantial but unqualified. It declares DigitalOcean SGP1 capture and TOR1 render pools, private R2 temporary objects, context-bound AWS KMS encryption, a fenced Node Lambda transcription dispatcher, cleanup, retry, finalization, and provider policy gates. No real staging journey has proved capture-to-download or Recording-to-final-Transcript, and no truthful end-to-end synthetic monitor exists.

Cloudflare RealtimeKit changed the available design space after the original July specs. Current official documentation includes managed composite Recording, per-Participant audio track Recording, direct customer-cloud upload, post-Episode speaker-aware Transcription, real-time transcript events, and signed webhook events. RealtimeKit remains beta and its storage credential/encryption contract does not automatically satisfy Chalk's current R2/KMS boundary. The later plan therefore needs an explicit choice among finishing the custom pipeline, moving Artifact generation to RealtimeKit, or using RealtimeKit for capture while keeping Chalk's normalization and durable Artifact authority.

## 2026-08-23: media-plane architecture ruled

Hasan ruled out RealtimeKit Recording and Transcription because its managed export economics are too expensive for Chalk. The launch design targets Cloudflare SFU directly. The domain and worker contracts must remain provider-neutral so a custom mediasoup media-plane adapter can supply equivalent authenticated track and lifecycle inputs later without changing Recording, Transcript, SDK, UI, or Artifact behavior.

## 2026-08-23: product scope locked

Hasan selected a single deterministic 720p composite Recording as the durable media Artifact. Isolated audio and the speaker-turn manifest are temporary Transcription inputs rather than permanent customer-facing tracks. Space policy supports `disabled`, `manual`, and `automatic` Recording modes. Tenant/Space Transcription policy supports `disabled`, `on_demand`, and `automatic`. The launch Transcript is post-Episode; live captions remain a separate later feature.

## 2026-08-23: implementation spec drafted and critiqued

The implementation plan is now a full desired-state spec with acceptance criteria, authority boundaries, state machines, a direct Cloudflare SFU `CapturePlane`, versioned capture and bundle contracts, deterministic `composite_720p_v1` rules, SDK and React/React Native surfaces, retention, deletion, observability, staging proof, and a resumable execution DAG. The only provisional product assumption is a 24-hour on-demand Transcription source window; it is explicit and can change before implementation.

Two read-only blind-spot reviews found real gaps in the first draft. The final draft now separates Sync reservation acknowledgment from later capture readiness, gives automatic Recording a first-class system authority, removes competing public Recording creation paths, defines exact Artifact authorization and policy precedence, mounts a private worker boundary with immutable job envelopes, serializes Cloudflare SDP work by capture epoch, adds a control-plane key broker and server-owned object keys, freezes the bundle/layout contracts before worker lanes split, persists Transcription source expiry and leases, makes public Recording completion atomic with render commit, defines hard-delete races and signed-URL limits, fixes the execution dependency graph, and names the exact webhook and synthetic monitor contracts.

## 2026-08-23: implementation wave started

Implementation is local-only and time-boxed to a continuation handoff before 02:00 PKT. Four disjoint workers own Sync readiness/system authority, the API Recording aggregate and atomic commit, private recorder-worker composition, and the provider-neutral capture contract. The root thread owns Artifact policy resolution, Episode snapshot validation, and removal of public Recording materialization routes.

The first root slice is working: `artifactpolicy` now resolves the complete Tenant-ceiling and Space-mode matrix, validates the 24-hour source ceiling and retention bounds, freezes `episode_config.v2` plus `composite_720p_v1`, and emits a seconds-based snapshot document. Episode snapshot validation accepts this versioned Artifact policy while preserving old snapshots. Focused policy and Episode tests pass.

The public API no longer mounts or generates create/update Recording routes or public reservation/pipeline routes, so only Sync can initiate future materialization. Generated OpenAPI and TypeScript contracts no longer contain those operations. Recording signed downloads now reject lifetimes above five minutes. HTTP verification is waiting for the concurrent aggregate worker to finish its migration and regenerate `sqlc`; the temporary compile failure is confined to its in-progress files.

## 2026-08-24: control-plane foundations integrated

The provider-neutral `CapturePlane` now defines the six capture operations, Chalk identity and epoch fences, opaque provider references, typed bounded errors, track canonicalization, and a reusable adapter conformance harness. The private recorder-worker router is composed only on the mTLS listener with SPIFFE verification. Public routing cannot reach it, and Recording readiness depends on both capture and render pool health.

Sync now treats start provider acknowledgment as reservation only. It remains in `starting` until an internal `recording_capture_ready` operation proves the originating start operation and wins a monotonic capture-epoch fence. Automatic starts persist explicit `system` and `recording_policy` authority without creating a Participant. The same separation is being applied to stop so `stopped` cannot appear before durable capture completion.

The API aggregate preserves Sync's Recording ID through the public row, capacity reservation, pipeline, capture job, bundles, render job, and final Artifact facts. SQLC is regenerated, and the migration adds the readiness operation plus final storage columns. Review found that final commit must authorize the public Recording before any data-changing CTE and that production still lacks a Recording controller supplying the reservation facts to `SFUExecutor`; both findings are back with the aggregate owner.

Root Go re-verification is temporarily blocked because the shared downloaded Go 1.25.13 toolchain and module cache lost files during a focused run. The lane tests passed before that cache failure, and Sync focused tests pass independently. No deployment, production mutation, commit, or full gate has occurred.

## 2026-08-24: implementation wave handed off

The Go toolchain cache recovered after downloading its missing dependencies. Focused domain, capture, Recording pipeline, provider bridge, HTTP, Postgres adapter, and command-package checks now pass. The generated SDK drift check and dedicated Sync Recording suite also pass. The broader Postgres integration package still cannot prove its Recording scenario because the configured shared database lacks the `recording_capacity` relation.

Review closed two correctness gaps before handoff. Artifact commit now authorizes and locks the public Recording and its reservation coordinates before any data-changing CTE, and exact ambiguous retries recover the existing Artifact while conflicting facts fail. Sync stop now mirrors start readiness: provider acknowledgment leaves `stopping`, and only a fenced `recording_capture_stopped` operation reaches `stopped` after durable capture completion.

Production does not inject a Recording controller yet. The current provider operation lacks the Space and capacity facts required for a safe reservation, and stop has no capture-worker control contract. Returning success without those facts would lie about both capture start and completion, so the executor remains bounded and retryable. The durable continuation plan is in `scratchpad/sfu-recording-transcription-implementation-handoff-2026-08-24.md`.
