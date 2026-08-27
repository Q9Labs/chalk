# Recording SFU implementation continuation

## 2026-08-25: inherited state recovered

This thread resumed Codex thread `01a02f28-25b9-76c3-9a72-f92dc5ca1046` from its frozen handoff. The inherited API and Sync Recording foundation remains uncommitted in the root checkout and has not changed since the 2026-08-24 handoff. The repository root is registered as a bare coordination worktree, so Git checks use explicit `GIT_DIR` and `GIT_WORK_TREE` values without changing repository configuration.

The next dependency order is unchanged: persist Tenant and Space Artifact policy and freeze it into new Episode snapshots, then give the Recording orchestrator one durable server-derived input before composing start and stop. RealtimeKit remains excluded, production remains untouched, and the legacy worker request bodies will not be trusted until they become immutable `recorder_job.v1` envelopes.

## 2026-08-25: Recording orchestrator authority selected

The Recording start reservation will be derived by Sync inside the existing external-operation acceptance transaction. Sync already holds the immutable Episode policy, Space identity, durable Participant projection, command operation ID, Recording ID, and journey carrier at that boundary. It will persist the typed reservation envelope in the existing external-operation JSON and replay those exact facts to the API.

The API will add the envelope to `provideroperations.OperationInput`, canonical JSON, and fingerprint. The existing provider-operation receipt already persists canonical payload plus its digest, so adding separate envelope columns would duplicate authority. The start controller will materialize the aggregate with the operation ID as the idempotency key. Stop will persist a separate operation-ID fence on the Recording pipeline and acknowledge only that durable reservation; capture completion remains a later fenced callback to Sync.

## 2026-08-25: Artifact policy persistence verified

Space-create idempotency now distinguishes omitted policy from explicit `disabled`, which matters because an omitted Transcription policy seeds the current Tenant default. The inherited Recording migration was also repaired so a fresh schema can replace the generated operation-name constraint and restore it on rollback.

Local PostgreSQL 18.3 passed Recording and Artifact-policy migration up/down/up. The Dashboard join integration test now proves that Episode creation freezes a valid `episode_config.v2` document, including Tenant ceiling clamping and provider, retention, and source-window facts.

## 2026-08-25: start reservation limits fixed

Sync will persist the start reservation at the qualified Episode maximum of ten Participants and four Mbps, with duration capped at the lesser of 120 minutes and the locked Episode time remaining. Reserving only the current Participant count would let later joins oversubscribe the global 100-Participant capture ceiling because no later capacity-adjustment fence exists.

## 2026-08-25: recorder job authority seam mapped

`recorder_job.v1` needs an append-only attempt-authority row, not a mutable JSON field on `recording_jobs`. Each row must preserve canonical envelope bytes and a SHA-256 digest for one job, attempt, fencing generation, and capture epoch, while every worker mutation repeats that digest and fence.

Claim also needs a stable worker request key. The current claim body contains only lease duration, so a response lost after commit can make the retry lease another job. The claim receipt must replay the original attempt authority and lease for the same worker/request key before plan, SDP, key, or object authority can be trusted.

## 2026-08-25: Recording orchestrator database authority verified

Provider start receipts no longer require the public Recording row to exist before dispatch, and receipt replay validates canonical semantics and the stored fingerprint without depending on PostgreSQL JSONB byte formatting. The pipeline now persists `policy_snapshot_version`, so the later recorder claim can derive its immutable policy fact without reading the provider receipt.

Stop reservation now binds Tenant, Episode, and Recording, replays the same operation ID after later state changes, rejects a different operation ID, and blocks a stopped capture job from being claimed after retry recovery. The updated migration passed local PostgreSQL down/up, and focused integration tests proved start preparation before Recording materialization, JSONB reconstruction, wrong-Episode rejection, stop replay/conflict, and stopped-capture claim rejection. Sync also preserves the API's stable Recording failure reasons and rejects malformed non-string response reasons.

## 2026-08-25: recorder job attempt authority verified

Each leased recorder attempt now has one append-only `recorder_job.v1` authority row with canonical envelope bytes, SHA-256 digest, capture epoch, claim request ID, worker owner, lease token, and lease expiry. A transaction-scoped claim-request lock makes concurrent retries replay the first committed authority instead of leasing a second job, and every heartbeat, completion, failure, bundle, and Artifact callback must repeat the immutable attempt fence before its unexpired lease can mutate state.

Artifact replay now authorizes the historical attempt before returning an existing exact Artifact, capture claims reject expired or stopped reservations, and render deadlines derive from capture completion plus the bounded render duration. Local PostgreSQL migration down/up installed append-only triggers for update, delete, and truncate; focused integration tests passed the claim concurrency, authority replay, expiry, render deadline, callback, and Artifact replay paths and left zero authority rows after cleanup.

## 2026-08-25: durable CapturePlan authority verified

Capture workers now long-poll a private `capture_plan.v1` control surface whose authority is the immutable capture attempt envelope and current unexpired worker lease. PostgreSQL appends canonical plan revisions under the envelope's opaque plan handle, derives Participant identity and stable join order from Sync's folded state plus the durable Participant lifecycle, parses only canonical v1 publication references, and stops the plan at the reserved hard deadline or durable pipeline stop.

The exact local Chalk database passed migration down/up from `20260825040000`, and PostgreSQL exposes update/delete plus statement-level truncate guards on both CapturePlan and recorder-attempt authority. The integration proof built revision 1 from a real publication, built revision 2 after a Sync display-name change, returned no plan when the source stayed unchanged, rejected all mutation forms, and left both append-only tables empty. Focused API tests, CapturePlane vet, migration contract tests, and the isolated generated-SDK drift check pass. The remaining Cloudflare runtime is still fenced from implementation until a named non-production spike target and the provider's undocumented close-session and inspect-state mappings are resolved; work continues on the provider-neutral durable SDP queue.

## 2026-08-25: durable capture signaling authority verified

Recorder signaling now crosses a provider-neutral `capturesignaling` port backed by an ordered PostgreSQL command queue. Each session and command repeats the immutable recorder-attempt fence, one active execution token serializes provider calls, canonical request and result bytes make exact retries replay-safe, a durable singleton rate budget keeps all API replicas below 50 provider calls per second, and ambiguous provider outcomes remain at the queue head until an explicit recovery path resolves them. Six private capture-worker routes expose create, pull, renegotiate, inspect, close-tracks, and close-session operations when a real CapturePlane adapter is injected; render workers cannot use them and the executable does not mount a fake adapter.

The bounded code review found and the implementation fixed live authority failures around heartbeat renewal, transaction-start time, pre-dispatch claim abandonment, outstanding SDP negotiation, unconfirmed close results, and ambiguous queue ordering. Signaling now locks the session before it locks and rechecks the live job authority, so a worker cannot dispatch after losing its lease and heartbeat cannot deadlock behind a session wait. An in-flight execution token remains bounded by the lease horizon accepted at claim time, while a concurrent heartbeat may safely extend the same owner and token before completion. CapturePlan reconciliation locks and rechecks the live job after its advisory lock.

The exact local Chalk database passed signaling migration down/up to `20260825050000`. Database integration proves heartbeat-renewed plan and signaling authority, post-lock expiry rejection, pre-dispatch release and reclaim, ambiguous-head blocking, exact negotiation revision, failed-close state preservation, immutable queue storage, and clean teardown. Focused API tests and vet pass, SQLC and SDK generated drift checks pass, six signaling triggers are active, and the signaling, plan, and attempt-authority tables are empty after cleanup. The actual Cloudflare/Pion adapter remains blocked on a named non-production target plus confirmed close-session and inspect-state provider contracts.

## 2026-08-25: managed Cloudflare SFU contract verified

Hasan approved one bounded production contract probe against Chalk's existing managed Cloudflare SFU app, with no deployment or traffic change. The bodyless session-create request succeeded, inspection returned the documented track collection plus data-channel state, and the new session contained zero tracks. No track cleanup was required, no credential or session reference was printed or persisted, and the empty session will expire because the provider has no session-delete endpoint.

Runtime composition now reuses one Cloudflare adapter instance for the existing provider bridge and recorder capture signaling. The adapter implementation and focused contract tests remain in progress; no deployment has been performed.

## 2026-08-25: Cloudflare CapturePlane adapter verified

The existing Cloudflare SFU adapter now implements the provider-neutral CapturePlane port. It creates bodyless sessions, pulls explicitly identified remote tracks, maps the provider's offer and answer combinations into durable negotiation requirements, inspects track state, and closes caller-supplied MIDs without keeping package-global session state. A bounded per-adapter replay cache protects immediate duplicate calls while the PostgreSQL signaling queue remains the durable authority across process restarts.

The API composes one managed SFU adapter for both provider operations and recorder capture signaling whenever Recording is enabled. The final remote API gate passed migrations through `20260825050000`, focused and integration tests, vet, staticcheck, vulnerability scanning, and lifecycle checks. The gate also caught a PostgreSQL writable-CTE visibility defect in Tenant creation; the query now returns its seeded policy from the CTE that inserted it, and fresh PostgreSQL onboarding tests pass. No deployment, traffic change, commit, or push occurred.

The bounded code review produced four hypotheses. The real worktree falsifies the Sync reservation and generated-SDK findings: Sync attaches the immutable `recording_reservation` payload, its focused client test proves the request, and generated contracts already omit retired Recording mutation routes while exposing the Artifact-policy fields. Two broader Artifact-policy findings remain: disabled Transcription policy is not yet checked at dispatch, and Tenant retention seconds need an upper bound before conversion to `time.Duration`. These do not change the Cloudflare adapter contract, but they block a final release handoff for the full inherited change set.

The next Recording critical path is the Pion capture worker. It must claim `recorder_job.v1`, wait on `capture_plan.v1`, drive the six private signaling operations with one peer connection per capture epoch, bind incoming tracks by MID, write fenced segments and gap facts, heartbeat its lease, and recover through a new capture epoch after ambiguous or broken transport state.

## 2026-08-25: Pion capture signaling core verified locally

The capture worker now has a concrete Pion v4 peer adapter, a strict HTTPS private control-plane client, and a provider-neutral coordinator. One peer connection owns one capture epoch; provider negotiation IDs remain opaque fences; pulled tracks bind to authenticated Chalk publications by MID; later plans close removed or replaced tracks before pulling additions; and SDP exchanges are serialized and bounded. The client rejects redirects, oversized or non-canonical responses, wrong-job projections, and non-HTTPS control-plane URLs while propagating Chalk journey and W3C trace context.

The coordinator reconstructs and checks `recorder_job.v1`, enforces exact `capture_plan.v1` authority and the hard deadline, accepts idempotent lease renewal, and verifies every signaling result against its command key and plan revision. The concrete Pion peer, control-plane client, plan decoder, and coordinator pass focused tests and vet; the final remote API gate is running.

This is still an unwired core, not a production recorder. The private API has no key-broker route, scoped object allocation/upload authority, or capture-ready/capture-stopped bridge, and the worker has no RTP-to-`recording_bundle.v1` writer or terminal gap persistence. The fixture-only CLI therefore remains fail-closed. No additional production calls, deployment, commit, or push occurred.

## 2026-08-25: Pion capture signaling core passed the remote gate

The exact source state passed the remote API gate on the M4 Mac mini: format and module drift checks, SQLC vet, all migrations through `20260825050000`, the full Go test suite, lifecycle smoke, `go vet`, Staticcheck, and vulnerability scanning. Targeted race tests also passed for `internal/recordercapture`, `internal/adapters/pion`, and `internal/recorderworker`. The isolated checkout, PostgreSQL process, and task artifacts were removed after verification.

The first gate attempt found and removed one unused Pion test helper. A later reduced remote copy omitted repository-level semantic, Sync, and webhook fixtures, so that harness run was discarded and replaced with the exact API source plus every cross-package fixture read by API tests. The final run is the authoritative green result.

## 2026-08-25: encrypted bundle authority and Sync lifecycle bridge verified locally

The capture runtime now requests one KMS data key under the exact recorder-attempt authority, writes canonical RTP and gap facts into `recording_bundle.v1`, clears plaintext after encryption, reserves server-owned R2 object identity, finalizes exact encrypted facts, uploads through a separate no-mTLS client, and commits only after the control plane verifies provider HEAD facts. Ready and stopped callbacks now repeat the live lease and envelope fence and publish the exact three-field Sync operations under semantic request keys that remain stable across attempt replacement.

A PostgreSQL integration test proves the callback transaction, journey root, exact Sync payload, lost-response replay after Sync advances, late-new-operation rejection, and stopped publication. The capture daemon now derives one stable Chalk journey and sampled W3C trace context from the claim request plus envelope digest and propagates it through signaling, key, object, heartbeat, completion, and lifecycle calls. The Execution Trace Harness includes the managed `cf_sfu` capture path, encrypted R2 commit, lifecycle callbacks, and an explicit stale-attempt failure signal. Focused API and Sync tests pass; the final remote API gate for this exact source is running. No production change, deployment, commit, or push occurred.

## 2026-08-25: end-to-end runtime evidence and repository gate blocker

The exact API source passed the complete remote API gate, including migrations through `20260825060000`, the full Go suite, lifecycle smoke, format and module checks, SQLC vet, `go vet`, Staticcheck, and vulnerability scanning. Remote race checks also passed for the recorder worker, canonical bundle, lifecycle, and PostgreSQL adapter packages. A clean dogfood rerun verified the managed Cloudflare SFU trace, AWS KMS key generation, encrypted R2 bundle commit, ready and stopped callbacks, and the expected stale-attempt fence. The resulting recording was uploaded to Drive and its anonymous link returned HTTP 200.

The explicit full repository gate then stopped at the language ratchet. The canonical local check reports 127 new `session` occurrences under `apps/api`; the provider-neutral Recording signaling stack used `RecordingCaptureSession` where Chalk vocabulary requires a capture connection. That domain and database concept is being renamed to `CaptureConnection`, while Cloudflare `/sessions` and `sessionId` or `sessionDescription` wire literals remain isolated at the provider adapter. A separate inherited `pnpm-lock.yaml` mismatch with the concurrently removed React SDK test dependencies also blocks a frozen workspace install. No production change, deployment, commit, or push occurred.

## 2026-08-25: capture connection vocabulary and fresh schema verified

The provider-neutral capture signaling model, SQL authority, operation names, generated SQLC surface, recorder worker, coordinator, and trace scenario now use `CaptureConnection`. Cloudflare wire fields and routes remain at the adapter edge, and repeated provider literals were consolidated so the staged API vocabulary count is 984, two below the previous 986 baseline. A disposable Git index that includes every new API file passes the language ratchet and diff check.

The remote full gate now proves a fresh PostgreSQL 18 migration through `20260825060000` with `recording_capture_connections`, and the complete API gate passes against that schema. The gate also found and fixed an unreachable Sync stop fence: non-start operations had matched before `stop_recording`, so a stop could bypass the active-Recording check. Warnings-as-errors compile and the focused lifecycle suite now prove an inactive stop is rejected.

Strict Credo then exposed seven Recording-specific refactoring failures. Small payload, fence, validation, and operation-result helpers removed all seven; strict Credo, warnings-as-errors compile, 36 Recording tests, and the basic Sync gate pass. The database-backed correctness profile still reports legacy Recording outcome and policy-decision compatibility failures, so the same Sync lane is repairing those before the full gate resumes. The React SDK manifest-to-lockfile drift was reconciled mechanically; frozen pnpm install and Syncpack now pass. No production change, deployment, commit, or push occurred.

## 2026-08-25: Recording policy rejection persistence verified

The fresh-database Sync profile exposed one final compatibility defect after the Recording lifecycle repairs: PostgreSQL rejected the terminal `recording_policy_disabled` participant decision because the receipt-shape constraint did not include that reason. A forward migration now permits that reason only for `start_recording`, while its rollback restores the prior constraint and refuses to erase rows that require the new contract. The canonical schema mirrors the migration.

The focused PostgreSQL lifecycle suite passes 21 tests after every migration through `20260825060000`. The complete remote Sync correctness profile now passes 264 tests with 4 intentional exclusions, plus the TypeScript Sync replay and whiteboard checks. The full remote monorepo gate is running against the same committed temporary snapshot. No production change, deployment, commit, or push occurred.

## 2026-08-25: explicit full-gate projection blocker repaired

The repository smart gate passed, but the clean temporary snapshot had no changed-path signal, so the authoritative run was corrected to explicit full mode. That run passed the fresh API and Sync service lanes, then stopped because the checked-in canonical OpenAPI JavaScript projection predated the Recording API surface. Regenerating it from the canonical OpenAPI source restored local API design parity at 77 paths and 126 schemas. The final full-mode run will include this projection and the two audited policy-boundary repairs.

## 2026-08-25: remaining Artifact policy boundaries closed

Retention seconds now use one shared safe maximum of `9223372036`, the largest whole-second value that Go can convert to `time.Duration` without overflow. Tenant request validation, immutable Artifact policy documents, canonical schema checks, and a new reversible migration all enforce that same ceiling for Recording and Transcript retention. Focused Go and race tests pass, and a fresh PostgreSQL migration resolves both bounds as `0..9223372036`.

Transcript request authority now reads the completed Recording's immutable Episode snapshot before it creates any Transcript or artifact job. `disabled`, missing, and unknown legacy modes fail closed with `transcript.disabled`; `on_demand` and `automatic` remain allowed; and an existing idempotent result replays before policy evaluation. A fresh-PostgreSQL integration test proves the SQL query, no-side-effect rejection, both allowed modes, legacy behavior, and replay order. OpenAPI and the generated TypeScript SDK expose the new typed error, and the complete local contract check passes. The final explicit remote full gate is running with both repairs.

## 2026-08-25: public retention wire contract corrected

The full workspace type lane exposed a deeper OpenAPI defect: the generator treated the server-only `OptionalInt64` presence wrapper as a required public `{Set, Value}` object. The generator now recognizes this helper like the existing optional string and JSON helpers, so Tenant PATCH exposes optional nullable integer fields with exact retention and source-window bounds. A focused codegen test locks that wire shape, OpenAPI and all generated TypeScript SDK projections are current, and the contract check passes.

The corrected SDK removed the web payload error without an adapter workaround. Two dashboard Space fixtures now supply the required Recording and Transcription policy fields, and the exact web type lane plus 14 focused dashboard tests pass. The explicit remote full gate is running against this corrected final snapshot.

## 2026-08-25: explicit full monorepo gate passed

The complete web suite exposed one more response-fixture projection gap; its shared Tenant and Space helpers now contain the required Artifact and Space policy facts, and all 106 web test files with 501 tests pass. The fresh install also proved that React Native tests had depended on the sibling React SDK's removed test stack. React Native now owns and imports its test dependencies directly; frozen install, type-check, 35 files, and 89 tests pass without restoring the React SDK dependencies.

The final remote `pnpm run gate -- --full` passed every selected lane: language and hygiene checks, secret and static security scans, dependency audit, fresh PostgreSQL API migrations through `20260825070000`, the complete Go API gate, Sync correctness with 264 tests and 4 intentional exclusions, generated contracts and SDKs, workspace dependency policy, test presence, all workspace type-checks/tests/builds, recorder OpenTofu validation, package publication layout, and TypeScript resolution. The disposable checkout restored two baseline Facehash tests only because the shared worktree has unrelated user-owned deletions that otherwise make Vitest report no test files; those local deletions were not changed.

No production deployment, push, or shared-worktree commit occurred. The managed runtime evidence remains deterministic and provider-contract-backed because no named non-production live media target was supplied.
