# Chalk Meeting Recording Sidelining

Status: Draft  
Owner: Hasan Shoaib  
Refreshed: July 15, 2026  
Companion: `scratchpad/chalk-recorder-system-guided-spec-2026-07-14.html`

## Background

Chalk has built substantial recording foundations without completing a recording product. The repository contains recording controls, SDK methods, public REST routes, Sync commands, durable pipeline primitives, fixture-only workers, and scale-to-zero infrastructure policy. These surfaces do not form one working path: no checked-in runtime can capture a real meeting end to end.

The partial user experience is the problem. A person can see recording controls or claims and assume the meeting is being captured, while the implementation may only create metadata or leave Sync in `starting`. The retained developer contracts are useful for restarting the work later, but they must be explicitly disabled at the server boundary and unable to activate runtime or cost.

### Current state

- Marketing, SDK documentation, React components, and React Native defaults present meeting recording as available.
- The TypeScript client exposes `startRecording` and `stopRecording`. Sync grants recording authority to hosts and cohosts by default, persists the start operation, and has no configured recording adapter to complete it.
- Public REST and generated SDK surfaces expose recording create, update, reservation, pipeline, read, download, and transcription-from-recording operations. Some only mutate metadata; reservation can create a recording row, pipeline, and pending capture job when health gates are open.
- Custom capture and render commands accept fixtures only. The worker router is not mounted, no external reconciler exists in the repository, and default infrastructure prohibits mutation and keeps recorder compute at zero.
- There is no managed RealtimeKit recording client, webhook, importer, or provider start call in the checked-in implementation.

### Desired state

Meeting recording is absent from Chalk's end-user product and costs nothing to operate. Users see no recording promise, control, status, automatic-recording setting, or post-meeting download. SDK methods, React and React Native recording utilities, REST routes, generated OpenAPI operations, schemas, and historical decoders remain available to developers for compatibility and a future restart, but every operation that could begin or advance recording returns a deterministic `recording_disabled` result before durable or external effects.

Sync keeps its recording command schema and compiled implementation but detaches recording capability and command registration from the active path. Recorder services, workers, provider bridges, reconcilers, schedules, and infrastructure remain detached or unapplied at zero capacity. Re-enabling later is a small, explicit registration change backed by a new qualification decision, not a cleanup of commented-out, uncompiled code.

## Decision

Sideline meeting recording at the product and runtime boundaries. Do not replace the custom recorder with managed recording in this change.

Keep the SDK methods and REST contract shapes. Do not render recording in Chalk-owned web or mobile UI. Keep REST read/list/download behavior for existing completed records, but gate create, update, reservation, pipeline mutation, and transcription-from-recording work with the canonical `recording_disabled` result. Keep Sync recording types and handlers compiled, remove recording from active role capabilities and command dispatch, and reject old commands before they write state.

This document supersedes the managed RealtimeKit launch decision previously held in this file and the launch direction in the July 11–14 recorder specs. Those documents remain technical history and dormant implementation reference; none authorizes a recording deployment, provider integration, or production mutation.

Literal commented-out source is not the target state. Chalk retains compile-tested modules and detaches them at explicit registration seams, because dormant code that no longer compiles is not easy to restore. A future recording project restores those seams only after a new source-of-truth spec approves architecture, spend, privacy, complete consumer behavior, and end-to-end qualification.

## Product behavior

### Chalk-owned clients

A user joining or ending a meeting sees no Record action, recording timer, recording badge, recording tab, recording download, guided-tour step, or recording-related empty state. Scheduling and room settings do not offer automatic recording. Marketing and product documentation make no recording claim.

Chalk's web and mobile apps explicitly set recording capability to false; they do not rely on an SDK default. Live transcription remains independent and may stay visible where it works without a meeting recording. The mobile Headquarters dictation code records local audio for a separate workflow and is not part of this decision.

### SDK consumers

The TypeScript client retains recording methods. React and React Native retain recording hooks, components, types, and feature options. Generated clients retain REST recording methods. Developer documentation labels meeting recording disabled and makes clear that initiation returns `recording_disabled`; it does not present the methods as a working product.

An external app that chooses to render a retained recording component receives the same deterministic disabled result. The SDK must not simulate success, keep a local `starting` state, or swallow the rejection.

### REST clients

REST routes remain registered and present in OpenAPI. Read, list, and download-url operations continue to serve authorized completed historical records. Any operation that can create or advance recording work returns HTTP `409 Conflict` with bounded code `recording_disabled` before a recording row, reservation, pipeline, job, object, provider call, or transcription job is created or changed.

The disabled mutation set includes recording create, caller-selected recording update, reservation create/extend, and transcription-from-recording. Cleanup operations that can only release pre-existing reservations may remain enabled if a focused test proves they cannot increase capacity or enqueue work.

### Sync clients

The Sync v3 command schemas and TypeScript methods remain. New sessions grant no `manageRecording` capability. Active command dispatch has no recording handler registration. An old client sending `start_recording` or `stop_recording` receives `recording_disabled` before Sync creates a side-effecting receipt, recording row, recording projection, external operation, or pipeline job. Replays produce the same rejection.

No request may remain pending, enter `starting` or `stopping`, reserve capacity, open object storage, invoke a provider bridge, or enqueue transcription.

### Historical records

This change deletes no rows or media. Existing completed records may still be read and downloaded through authorized REST routes. Replaying historical Sync state remains safe: replicas can decode it, but Chalk-owned UI does not render recording and no replay restores recording capability or dispatch registration.

## Scope

### In scope

- Remove meeting-recording claims from marketing, screenshots and alt text, product documentation, examples, guided tours, scheduling, and Chalk-owned meeting UI.
- Explicitly disable recording in Chalk's web and mobile app configuration, including diagnostics, end screens, and previews.
- Keep public TypeScript, React, React Native, REST, OpenAPI, and generated SDK recording surfaces compile-tested; document their disabled state.
- Add one fail-closed REST mutation gate that returns `recording_disabled` before repository, storage, provider, pipeline, or transcription effects.
- Detach Sync recording capability and command dispatch at one obvious registration seam while retaining schemas, methods, handlers, and historical decoding.
- Keep recorder services, worker routers, provider bridges, reconcilers, and provider configuration detached from runtime startup.
- Keep recorder infrastructure detached from environment stacks or mutation-disabled with zero desired runtime capacity and no scheduled prewarm, recording canary, or recurring recording job.
- Add negative tests and observability proving attempted activation cannot create recording state or spend.
- Update the changelog or release notes to state that meeting recording is temporarily disabled in Chalk-owned products while developer contracts remain reserved.

### Non-goals

- Choosing or implementing a custom, managed, browser, or client-side recorder.
- Removing or renaming SDK methods, React or React Native exports, REST routes, OpenAPI operations, generated methods, recording tables, migrations, repositories, fixtures, worker protocols, or infrastructure modules.
- Disabling live transcription, uploaded-media transcription, local dictation, or ordinary microphone use.
- Redesigning unrelated meeting controls or changing general media permissions.
- Deleting historical rows, media, or cloud resources.
- Deploying, mutating staging or production, or inspecting production without explicit approval.

## System boundaries and source of truth

The disabled server registration is the authority. Hidden UI is defense in depth; retained SDK and REST contracts cannot activate recording by themselves.

| Boundary | Desired rule | Retained for later |
| --- | --- | --- |
| Marketing and Chalk docs | Recording is not named as an available product capability. | A short developer note explains the reserved disabled contracts. |
| Chalk web and mobile | No recording control, status, automatic setting, diagnostic action, or end-screen download is rendered. App configuration sets recording false explicitly. | Shared SDK components and hooks remain available to external consumers. |
| TypeScript, React, React Native | Methods, types, hooks, components, and feature options remain exported and compile-tested. Disabled calls return `recording_disabled` without optimistic local state. | The same contract surface can back a later implementation. |
| Public REST API | Routes and OpenAPI operations remain. Reads and authorized historical downloads work; recording mutations fail before effects. | Route shapes, generated SDK methods, repositories, and migrations. |
| Sync v3 | Schemas and methods remain. New sessions grant no recording capability, and active dispatch has no recording registration. | Handlers, adapters, snapshot/event decoding, and tests. |
| API runtime | Recording capture, pipeline activation, health, worker, provider-bridge, reconciler, and transcription-from-recording execution are not mounted or scheduled. Read-only recording service wiring may remain. | Constructors, storage reads, and focused tests. |
| Infrastructure | Recorder root is detached from environment application or `enable_apply` remains false; desired nodes are zero and no activation credentials are supplied. | OpenTofu modules and validation tests remain source-only. |

There is one reactivation seam per boundary: app capability, REST mutation gate, Sync capability/dispatch registration, runtime service registration, and infrastructure stack inclusion. No environment variable alone may cross all seams or expose recording accidentally.

## Failure and offline behavior

| Situation | Observable result | Forbidden result |
| --- | --- | --- |
| Current user joins a meeting | No recording affordance exists. | Disabled or “coming soon” controls that advertise the feature. |
| SDK consumer calls a recording method | Typed `recording_disabled` result; no optimistic recording state. | A no-op success, local spinner, or swallowed error. |
| REST client reads a completed historical record | Existing authorized read/download behavior. | New recording work or broader storage access. |
| REST client calls a recording mutation | HTTP `409` with code `recording_disabled`. | A row change, reservation, job, object, provider request, or transcription job. |
| Sync client sends a recording command | Deterministic `recording_disabled` result with bounded telemetry. | `starting`, `stopping`, pending external operation, or provider dispatch. |
| A stale recording snapshot is replayed | Replica decodes it; Chalk UI stays recording-free. | Replay restores capability or dispatch. |
| Recorder environment values are accidentally supplied | Startup and infrastructure gates remain closed. | A service mount, schedule, provider call, bucket, key, or compute node. |
| Network is offline | Meeting behavior is unchanged; no recording path retries. | Background recording retries or queued activation. |

## Cost and operational posture

The required steady state is zero recording-specific runtime spend, not merely zero active recordings. Recorder compute remains at zero, and the sidelined topology has no recording-specific provider subscription, managed-recording invocation, prewarmed node, scheduled canary, background reconciler, new ingest bucket, encryption key, queue consumer, or always-on monitor.

Source code, database tables, retained SDK/REST contracts, historical object reads, and unapplied infrastructure modules do not count as new recording runtime cost. Existing shared PostgreSQL, API, Sync, and object-storage services may retain dormant code and schema, provided disabled mutation attempts create no recording loop, allocation, object, or external request.

Local and read-only infrastructure proofs must show:

- checked-in recorder configuration cannot mutate cloud state;
- desired capture and render capacity is zero;
- environment stacks do not include the recorder root, or its apply gate remains false;
- API and Sync release configuration contains no recording adapter, provider bridge, reconciler, worker listener, or recording schedule;
- no new recording secret, provider credential, storage binding, or monitor registry entry is required;
- accidental configuration fails closed with a bounded, non-secret diagnostic.

## Security, privacy, and observability

Sidelining prevents new meeting media, participant tracks, provider identifiers, signed URLs, recording metadata, or transcription sources from being created through a meeting-recording mutation. Historical download authorization and tenant storage-key validation remain unchanged.

Disabled attempts emit one bounded counter and trace outcome by ingress (`sdk`, `rest`, or `sync`) and reason (`recording_disabled`). They do not log request bodies, display names, meeting media, credentials, object keys, or identifiers beyond the existing safe journey reference. Startup emits one bounded configuration fact that recording execution is detached; it must not emit environment values or secrets.

No recording health monitor or synthetic check is added for an unavailable feature. Existing recorder dashboards may remain as historical artifacts, but they cannot page or imply an active service.

## Compatibility policy

Developer contracts stay stable; product availability does not. Retaining an SDK method or REST route is acceptable only because the server gives it one honest, typed disabled outcome and performs no recording work. Chalk-owned UI must not surface the retained contracts.

Do not comment out implementation bodies. Keep schemas, handlers, adapters, and modules compiled and covered by focused dormant tests, then detach them from active capability, dispatch, startup, and infrastructure registration. Re-enabling should be a small reviewable diff at those seams, but it still requires a new qualification decision.

## Implementation phases

One main-thread executor owns all code and contract changes. Read-only explorers may inventory surfaces and verify negative coverage, but workers do not split implementation across shared API, Sync, codegen, SDK, and runtime contracts. This preserves one coherent disabled state and follows Chalk's shared-worktree protocol.

### Phase 0 — inventory and freeze

- [ ] Record the complete product and runtime surface list across marketing, apps, React, React Native, TypeScript, REST, Sync, codegen, docs, runtime wiring, and infrastructure.
- [ ] Define the canonical REST and Sync `recording_disabled` response in existing error-contract conventions.
- [ ] Identify the single activation seam for app UI, REST mutation, Sync dispatch, runtime execution, and infrastructure.

Gate: the retained-contract list and detachment seams are explicit, and focused tests prove each rejection point precedes every recording write or provider boundary.

### Phase 1 — remove the product promise

- [ ] Remove recording claims from marketing, product docs, previews, tours, screenshots, and alt text.
- [ ] Set Chalk web and mobile recording capability false and remove recording controls, statuses, automatic settings, diagnostics, and end-screen downloads from app composition.
- [ ] Keep SDK exports and generated methods; update developer docs and types so disabled results are explicit and never optimistic.

Gate: repository search plus real web and mobile UI verification finds no current-user recording promise or action, while SDK compile tests, live transcription, and local dictation still pass.

### Phase 2 — detach execution

- [ ] Keep REST routes and OpenAPI operations, but gate all recording mutations before repository, pipeline, storage, provider, or transcription work. Preserve authorized historical read/list/download behavior.
- [ ] Remove `manageRecording` from default Sync capabilities and detach start/stop from active command dispatch while retaining schemas, methods, and compiled handlers.
- [ ] Keep capture/pipeline services, provider adapters, worker routers, and reconcilers out of runtime startup and schedules.
- [ ] Ensure SDK, REST, and Sync disabled attempts converge on `recording_disabled` without durable or external effects.

Gate: negative API and real PostgreSQL/Sync integration tests prove all disabled paths fail deterministically with zero durable or external effects, historical reads still work, and code-generation drift checks pass.

### Phase 3 — prove dormant and cost-silent

- [ ] Prove default infrastructure plans cannot create recorder resources and desired recorder capacity remains zero.
- [ ] Prove release configuration contains no recorder activation, secrets, provider bindings, schedules, or monitor entries.
- [ ] Add bounded disabled-attempt and startup telemetry, with assertions that no sensitive data is emitted.
- [ ] Run the API gate, Sync gate, root gate, generated-contract checks, local browser flow, and mobile verification surface.
- [ ] Update the changelog or release notes and capture final negative evidence in the session log.

Gate: one immutable local revision passes every focused and repository gate, and the executor observes the product, SDK, REST, Sync, database, runtime, and infrastructure outcomes below. Deployment remains separately authorized.

## Acceptance criteria

This change is done only when all of the following are observed in the same revision:

- [ ] Marketing, product docs, previews, tours, screenshots, and alt text make no meeting-recording product claim.
- [ ] Chalk web and mobile meeting surfaces contain no recording control, status, timer, tab, automatic setting, diagnostic action, or post-meeting download.
- [ ] Chalk apps explicitly configure recording false; unrelated meeting controls remain usable.
- [ ] Public React, React Native, TypeScript client, REST, OpenAPI, and generated SDK recording surfaces remain present and compile-tested.
- [ ] SDK and generated client recording calls return typed `recording_disabled` without optimistic state or swallowed errors.
- [ ] REST read, list, and download-url operations still work for authorized completed historical records.
- [ ] Every REST recording mutation returns HTTP `409` with code `recording_disabled` and creates or changes no recording row, reservation, pipeline, job, object, provider request, or transcription job.
- [ ] New Sync sessions grant no recording capability; active dispatch has no recording start/stop registration.
- [ ] Legacy Sync recording commands return `recording_disabled` and create no recording projection, side-effecting receipt, external operation, provider dispatch, or stuck pending state.
- [ ] Replaying a historical recording snapshot remains safe and cannot restore recording authority or Chalk UI.
- [ ] Recording execution services, worker routers, provider bridges, reconcilers, schedules, and recording canaries are absent from runtime wiring.
- [ ] Capture and render commands remain fixture-only; dormant handlers, domain code, migrations, and infrastructure source remain compiled or validated.
- [ ] Default recorder infrastructure is detached or mutation-disabled, plans zero runtime nodes, and requires no new recording-specific cloud resource or secret.
- [ ] Disabled attempts produce bounded, non-sensitive telemetry; no unavailable-feature health monitor pages an operator.
- [ ] Live transcription, uploaded-media transcription, mobile Headquarters dictation, and ordinary meeting media still pass focused regression tests.
- [ ] `apps/api/scripts/gate.sh`, `apps/sync/scripts/gate.sh`, `pnpm run gate`, generated-contract checks, and focused UI tests pass.
- [ ] A real local browser run confirms the absent Chalk web affordance, and the mobile verification surface confirms recording is absent while unrelated controls remain usable.
- [ ] No staging or production mutation occurred.

## Re-entry gate

Recording execution may return only under a new spec that replaces this one and proves a complete product state. That spec must choose one capture authority, define user consent and failure behavior, activate the retained SDK and API surfaces honestly, propagate journey and trace context, budget real provider and infrastructure costs, qualify success and failure end to end, and identify an approved deployment target. Until every gate passes, SDK and REST contracts remain disabled, Chalk UI remains absent, and runtime stays detached.

## Canonical vocabulary

- **Meeting recording** — server-side capture of a Chalk meeting for later playback; the product capability being sidelined.
- **Product surface** — Chalk-owned marketing, scheduling, web, or mobile UI visible to an end user.
- **Developer contract** — a retained SDK method, type, component, REST route, OpenAPI operation, or Sync schema.
- **Detachment seam** — one explicit registration point that keeps compiled implementation out of the active path.
- **Dormant foundation** — retained, compile-tested source, schema, fixtures, and unapplied infrastructure with no mounted runtime path or recurring cost.
- **Cost-silent** — no recording-specific provider invocation, storage allocation, key, queue consumer, monitor, scheduled job, or compute capacity.
- **Negative proof** — an observed test showing that a disabled attempt creates no durable state, external request, media object, or billable resource.
