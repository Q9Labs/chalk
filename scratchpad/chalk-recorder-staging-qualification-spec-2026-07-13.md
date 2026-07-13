# Chalk Recorder Staging Qualification Spec

Status: Draft companion to `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`.

Inputs:

- `scratchpad/chalk-recorder-control-plane-spec-2026-07-13.md`
- `scratchpad/chalk-recorder-cloudflare-capture-worker-spec-2026-07-13.md`
- `scratchpad/chalk-recorder-render-finalization-worker-spec-2026-07-13.md`
- `scratchpad/chalk-transcription-spec-2026-07-12.md`
- `scratchpad/chalk-observability-uptime-spec-2026-07-12.md`

Owner: Hasan Shoaib

## Purpose and authorization boundary

This spec defines the live staging proof required before Chalk can plan production recording. It qualifies the exact release, provider bindings, capacity constants, security boundaries, failure behavior, cleanup, observability, and cost at the ratified launch ceilings.

This document does not authorize production mutation. Before any staging apply, the active thread must confirm the exact staging environment, provider account/project identifiers, release manifest, permitted resources, activation window, and spend ceiling. A missing or ambiguous binding is a blocker, not permission to infer a target.

Pre-staging ends with reproducible artifacts, clean local gates, and reviewed no-apply plans. Staging qualification begins only after that handoff, runs through M4 evidence, and ends only after Q6 verifies cleanup and the dormant state. Production is a separate approved state.

## Qualification principles

- Evidence is observed from real Cloudflare, DigitalOcean, R2, KMS, database, monitoring, and transcription boundaries; a simulator cannot satisfy a provider gate.
- The tested release is digest-addressed and immutable. Every rerun records the same or a new unique release ID so stale artifacts cannot be mistaken for current proof.
- Workers append measurements and facts. The main thread judges pass or fail against ratified thresholds.
- A failed prerequisite, workload, drill, cleanup, security, monitor, or cost check closes recorder admission and stops progression. The evidence is preserved; constants are not weakened after a miss without re-ratification.
- Public repository evidence is redacted. Private resource IDs, account details, credentials, raw provider payloads, customer data, and media remain in `.private/` or the approved evidence store.

## Entry criteria

Staging qualification cannot begin until:

- all recorder control-plane local phases C0–C6 pass;
- capture phases K0–K5 pass against the selected supported Cloudflare contract;
- render phases R0–R5 pass on the shipped GPU image;
- every migration applies to a fresh isolated PostgreSQL database and API/Sync accept the resulting compatible schema;
- the complete local topology proves reservation, worker claim, fenced capture, encrypted bundles, render, artifact commit, transcription seed, drain, restart, and database-backed recovery;
- API, Sync, SDK, infrastructure, security, generated-contract, and repository gates pass;
- build artifacts reproduce with matching digests and compatibility metadata;
- staging OpenTofu plans pass policy, cost, destructive-change, public-origin, and production-target rejection checks;
- secret-flow review proves no reusable credential, media, private provider identifier, or full connection URL enters the repository, image, logs, traces, or public evidence.

## Exact staging bindings

The private active handoff records:

- AWS staging account/profile, region, KMS key policy, DynamoDB activation lease, EventBridge/Lambda reconciler, and permitted IAM changes;
- Cloudflare staging account, direct Realtime SFU application, transitional RealtimeKit binding if still present, R2 bucket, Tunnel, Workers plan, status surface, API token scopes, and recording-data region path;
- DigitalOcean team and project, SGP1 capture and TOR1 render regions, separate capture/render tokens, image digests, Droplet sizes, GPU contract, quotas, and hard node caps;
- exact PlanetScale PostgreSQL staging organization, database/branch, region, runtime and migrator roles, backup/restore point, connection budget, and clean-create or approved adoption procedure;
- two company-controlled Grafana stacks/accounts or the ratified alternative, alert destinations, status projection, and operator recovery access;
- transcription primary and fallback accounts, pinned models/versions, privacy terms, quotas, token scopes, pricing, and spend controls;
- exact recorder release ID, image digests, schema versions, monitor release, activation start/expiry, maximum spend, and named operator;
- the dated fixed-cost forecast against the $15 monthly dormant-staging warning and $200 combined fixed-resource hard ceiling, with any forecast increase above $10 per month paused for review; recorder media, storage, rendering, and transcription usage are separately funded and reconciled against the Q0 run ceiling.

Read-only inventory precedes mutation. Provider quota, GPU availability, account terms, region incompatibility, insufficient token scoping, unverified restore, or missing billing control blocks the phase.

## Evidence ledger

Every gate writes one immutable evidence record containing:

- evidence schema version, phase, gate, workload or drill ID, spec revision, release and image digests, database migration digest, provider-contract version, and monitor release;
- private references to exact provider resources and authority used;
- start, end, activation generation, operator, expected threshold, observed result, and binary verdict;
- workload shape, admission decisions, node schedule, resource use, provider usage, and cost;
- journey and trace references, sanitized logs, metrics queries, dashboard panels, probe results, object facts, database facts, and failure codes;
- cleanup, deletion, certificate revocation, node drain, scale-to-zero, and final Dormant proof;
- evidence expiry and requalification trigger.

Evidence never contains credentials, media, transcript text, display names, participant tokens, full object URLs, private provider payloads, or public customer identifiers.

## M0 — Provider and policy gate

M0 proves the exact accounts can support the architecture before capacity spend:

- Cloudflare contract supports the chosen native capture path, track selection, token lifecycle, required regions, and bounded quotas.
- DigitalOcean provides SGP1 CPU and contracted TOR1 RTX 4000 capacity, at least the ratified burst within 11 capture, 10 render, and 21 global nodes, separate scoped/expiring tokens, image and inventory APIs, and acceptable rate limits.
- R2 and KMS policies enforce tenant/job encryption context, scoped object authority, no public access, conditional writes, lifecycle, and preserved final objects.
- PostgreSQL region, schema, roles, backup, restore, connection budget, and migration compatibility are proven.
- Monitoring accounts, alert routes, independent probes, status projection, and monitoring-of-monitoring are available under accepted terms.
- Transcription providers meet pinned model, privacy, quota, fallback, pricing, and spend requirements.
- The dated plan remains below the $15 dormant-staging warning and $200 combined fixed-resource hard ceiling; a forecast increase above $10 per month pauses for review, while the separate recorder-usage ceiling is funded and recorded in Q0.

No M1–M4 work starts while an M0 item is unknown.

## M1 — Single-node control and security proof

M1 deploys the exact control-plane and one worker of each role:

- one-time bootstrap succeeds once and fails on replay, expiry, wrong environment, role, release, region, Droplet, or boot generation;
- node mTLS certificates carry the expected identity, rotate, revoke, and reject after node removal;
- workers cannot reach PostgreSQL or obtain DigitalOcean, KMS, or reusable R2 credentials;
- the private worker listener is unavailable through the public origin and rejects absent, wrong-role, stale, and revoked identities;
- assignment object intents enforce method, key, size, condition, content type, and expiry;
- activation lease expiry drains within five minutes, forces compute to zero, deletes root volumes, and writes a Dormant assertion;
- API/app replacement reconstructs the same release from PostgreSQL, provider state, and environment configuration without node-local repair.

## M2 — One real recording slice

M2 proves one scheduled and one unscheduled recording through every real boundary:

1. Reservation admits against fresh capacity, usage, and render schedule.
2. Scheduled capture prewarms five minutes before start and is ready two minutes before; unscheduled capture holds meeting open until lease acknowledgement within the measured bound.
3. The native worker joins the supported Cloudflare path, captures bounded tracks and timeline, renews authority, and uploads immutable encrypted bundles.
4. Capture completion creates exactly one render job.
5. TOR1 render decrypts in memory, uses the shipped GPU path, conditionally uploads and verifies the MP4, seeds the speaker-turn source and chunks, and commits within thirty minutes.
6. Transcription reaches its terminal committed outcome through primary provider and forced fallback without changing recording integrity.
7. Normal bundle/key/chunk cleanup, erasure, usage settlement, reconciliation, traces, metrics, logs, canary, alerts, and public-safe status all complete.

M2 includes capture-process loss, full capture-node loss, render-node loss, app/control-plane loss after renewal, stale fence, duplicate terminal report, R2 partial upload, provider 429, cleanup failure, and monitor-path failure. Expected behavior is visible gaps, fenced replacement, no duplicate commit, active-work preservation, closed admission where required, independent alerts, and eventual cleanup.

## M3 — Capture ceiling and recovery proof

M3 runs both ratified launch shapes:

- 20 concurrent three-person meetings;
- five ten-person meetings plus fifteen three-person meetings, totaling 95 participants.

Each meeting targets 3 Mbps including audio and admits no more than 4 Mbps; the supported aggregate ceiling is 80 Mbps. Four meetings, forty participants, and 16 Mbps per node is the target hypothesis; two, twenty, and 8 Mbps is the permitted fallback hypothesis. M3 measures both and qualifies one release constant plus one ready spare rather than treating both densities as simultaneously proven. Both workload shapes prove:

- scheduled and unscheduled admission, no-show expiry, extension, 120-minute stop warnings, and visible capacity failure;
- desired-node calculation, zero idle, prewarm, cold start, hard caps, provider quota refusal, and scaler failure;
- one process per meeting, sibling isolation, CPU/memory/network headroom, packet loss, jitter, keyframe latency, track churn, bundle cadence, object throughput, and cost;
- N+1 process and full-node loss with revocation, fresh fence, SFU rejoin, keyframe acquisition, first new bundle, explicit gap, and manifest reconciliation;
- app-node loss before renewal, during the twenty-two-to-twenty-minute renewal window, after the renewal deadline, and at authority expiry; each drill proves bounded existing authority, no unauthorized replenishment, no overlapping attempt, explicit `capture_authority_expired` where applicable, and complete usage settlement;
- six-hour soak followed by the approved burst shape without unbounded resource growth or stale health.

A density below the permitted two-meeting fallback, quota below eleven capture nodes, missed cold-start/start-hold bound, unaccounted gap, stale health, secret leak, or failure to preserve sibling captures fails M3.

## M4 — Render ceiling and deadline proof

M4 ends twenty two-hour recordings together, preserving the 40-output-hour bound. Earliest-deadline discrete scheduling must place every non-preemptive job on at most ten RTX 4000 nodes.

The shipped release must prove:

- at least 15× media processing including measured overhead;
- no qualified two-hour job over ten minutes;
- readiness and assignment within three minutes, transfer plus first-pass rendering within twenty, upload/verification/authorization within four, and three minutes retained for recovery;
- every final MP4 committed within thirty minutes;
- output codec, dimensions, frame rate, bitrates, seekability, duration, layout decisions, audio mix, speaker-turn manifest, and chunk mapping satisfy their contracts;
- GPU/node loss, transfer failure, upload conflict, stale lease, and one bounded retry do not duplicate commits or exceed retention;
- scratch sweeps, root-volume inspection, image/snapshot inventory, log/trace scans, process-exit checks, and object probes find no plaintext media or key artifact outside the bounded live process; normal deletion completes within one hour, and the twenty-four-hour orphan backstop plus hour-twenty-three terminal rule are observed;
- provider usage, node time, reservation exposure, object facts, transcription usage, and cleanup reconcile; the fixed-resource forecast and separately funded usage ledger each remain within their own ratified guardrail.

A processing factor below 15×, any job over ten minutes, any final deadline miss, more than ten nodes, missing recovery reserve, an observed plaintext/key artifact, incomplete deletion, or breach of either the fixed or usage guardrail fails M4 and closes recording admission.

## Failure matrix

Qualification records independent drills for:

- capture process and node loss;
- render process, GPU, and node loss;
- API/control listener, PostgreSQL, and reconciler loss;
- Cloudflare signaling, media, quota, and regional failure;
- DigitalOcean inventory, action, quota, and token failure;
- expired/replayed bootstrap and stale/revoked certificate;
- authority-renewal loss, lease expiry, stale fence, and duplicate/late report;
- corrupt, missing, overlapping, partial, orphaned, or conflicting R2 objects;
- KMS/key-authority failure and cleanup after partial decrypt;
- missed render deadline, exhausted retry, dead letter, and audited requeue;
- usage settlement mismatch, no-show expiry, extension rejection, and spend guard;
- monitor, telemetry backend, alert route, status projection, and canary failure;
- database restore, tombstone replay, app-node replacement, activation expiry, and forced Dormant cleanup.

Each drill names the expected admission state, active-work behavior, fence/retry outcome, terminal visibility, cleanup, alert, status projection, and recovery proof before execution.

## Monitoring and public status

Independent monitors cover Web, API, Sync, Media, Artifacts, Telemetry, and Status. Recorder pool self-report is an input, not the verdict. Every signed bounded monitor envelope carries credential-derived monitor ID, environment, component, unique result ID, issue and expiry times, target release, payload digest, outcome, and check timing. Ingestion rejects oversized, expired, future-dated, duplicate, replayed, revoked, cross-environment, and unauthorized-component envelopes. Key rotation has a bounded overlap. Stale evidence becomes Unknown; one component failure cannot suppress another result.

The artifact canary creates a bounded reservation, reaches terminal recording and transcription states, verifies authorized objects, observes cleanup, and publishes no customer or media data. Monitor replay, disablement, stale heartbeat, schema regression, alert delivery, and status projection are drilled independently of the API/app node.

## Execution phases and stopping rules

- [ ] **Q0 — Active handoff:** exact staging bindings, release, permissions, spend, activation window, and operator are confirmed in the active thread.
- [ ] **Q1 — Entry and M0:** local gates, reproducibility, plans, secret review, provider contracts, quotas, regions, restore, monitoring, and cost controls pass.
- [ ] **Q2 — M1:** one-node bootstrap, identity, private listener, authority, activation, drain, Dormant, and replacement pass.
- [ ] **Q3 — M2:** scheduled and unscheduled single recordings, transcription, failure slice, cleanup, observability, and canary pass.
- [ ] **Q4 — M3:** both capture ceiling shapes, density, N+1 recovery, autonomy, soak, usage, and cost pass.
- [ ] **Q5 — M4:** ending-together render, deadline, failure, retention, deletion, transcription handoff, reconciliation, and cost pass.
- [ ] **Q6 — Closeout:** evidence ledger is complete, staging returns to the approved idle state, credentials and assertions are rotated or revoked, compute is zero, cleanup is verified, and the binary verdict is recorded.

The main thread owns target confirmation, staging-only mutation after Q0, integration, verdicts, and cleanup; it never infers or mutates a production target. Researchers inventory provider contracts and pricing; explorers map repository evidence; they do not mutate infrastructure. M1 waits for Q0–Q1, M2 waits for M1, M3 waits for M2, and M4 waits for M3. Parallel drills are allowed only when they do not share capacity, identity, or evidence authority.

This spec is done only when Q0–Q6 have observed evidence and every ratified recorder gate passes. A failure means not done. Work stops with a qualified, dormant staging recorder and a complete private evidence ledger. It does not plan, apply, enable, or verify production.

## Open questions

1. What are the exact Cloudflare, DigitalOcean, AWS, PlanetScale, Grafana, and transcription staging account/project/deployment identifiers? Q0 is blocked until the active thread records them.
2. What separately funded usage ceiling and maximum activation window may the qualification run use? Q0 is blocked until both are explicit.
3. Do current DigitalOcean agreements guarantee SGP1 capture capacity, TOR1 RTX 4000 capacity, separate token scope, and the 21-node burst?
4. Which PlanetScale staging region and clean-create or adoption path are authoritative, and has restore been proven for that exact database?
5. Are two company-controlled Grafana Free stacks permitted under current terms, or should the monitoring architecture use a different ratified plan?
6. What external load runner and operator mailbox should own the six-hour capture soak, alert delivery, and status verification?
