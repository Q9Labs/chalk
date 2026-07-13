# Chalk Recorder Control Plane Spec

Status: Draft companion to `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`.

Owner: Hasan Shoaib

## Purpose and boundary

This spec defines the recorder control plane from reservation admission through worker authority, durable job transitions, scaling, reconciliation, cleanup, and public-safe health projection. PostgreSQL remains the sole authority for reservations, recording state, leases, immutable object facts, terminal outcomes, and usage settlement. Capture and render workers never connect to PostgreSQL, KMS, DigitalOcean control APIs, or R2 through reusable credentials.

The control plane does not capture or render media. The capture and render worker contracts live in their dedicated companion specs. Production activation is outside this document.

## Canonical terms

- A **reservation** atomically holds capture meetings, participants, input bitrate, duration, render-deadline capacity, and tenant usage exposure.
- A **job** is durable PostgreSQL work with one immutable identity, kind, attempt limit, availability time, lease, fencing generation, and bounded terminal detail.
- A **node identity** is a short-lived mTLS certificate issued after one-time bootstrap and live provider-inventory verification.
- A **job authority envelope** is the narrower assignment issued to one authenticated node for one fenced attempt.
- A **reconciler** compares database intent with provider inventory, node certificates, processes, leases, objects, deadlines, and usage facts, then records idempotent corrective actions.
- **Admission open** means every capture and render constraint needed by the reservation is fresh and qualified. Missing or stale evidence closes admission.

## Fixed limits and source-of-truth rules

- Production admission is capped at 20 captured meetings and 100 participants. Each meeting reserves one to ten participants, at most 4 Mbps input, and at most 120 minutes.
- Scheduled work prewarms five minutes before start and must have capacity ready two minutes before start. No-show capacity drains ten minutes after start when no capture lease was acknowledged.
- An unscheduled recorded meeting does not open until capture acknowledges its lease. The initial hold is at most 120 seconds and fails visibly as `recording_capacity_unavailable`.
- Capture desired capacity is the maximum of meeting, participant, and bitrate dimensions plus one ready spare while work is reserved or active. Capture is capped at eleven nodes, render at ten, and global recorder compute at twenty-one.
- Render admission uses earliest-deadline discrete packing against qualified service time. Aggregate output-hours division is not an admission algorithm.
- Recording intent and its first capture job are inserted in one database transaction. Capture completion and its render job are also one transaction.
- Lease mutation uses job ID, attempt, fencing generation, owner identity, and lease token. A stale or duplicate attempt cannot heartbeat, upload facts, complete, fail, or commit an artifact.
- Bundle and artifact facts are immutable after acceptance. Final object ownership is selected by the control plane, never by a worker or public client.

## Private recorder listener

The API process exposes a separate private TLS listener for recorder workers. It is not mounted under the public `/v1` router, accepts no browser CORS, cookie, bearer, or local-system-token authentication, and is unreachable through the public staging origin.

Bootstrap uses the assertion-authenticated `POST /internal/v1/recorder/bootstrap` endpoint. It does not require a client certificate because its sole purpose is to exchange one valid assertion for the first node certificate. Every other route requires that certificate:

- `POST /jobs/claim`
- `POST /jobs/heartbeat`
- `POST /jobs/progress`
- `POST /jobs/fail`
- `POST /jobs/complete`
- `POST /jobs/authority/renew`
- `POST /jobs/media-control`
- `POST /bundles`
- `POST /finalize`
- `POST /node-observations`

Every request derives worker ID, environment, and role from the verified certificate. Request bodies cannot select those values. Capture-only and render-only routes reject the wrong certificate role before reading media facts. `/jobs/media-control` is capture-only and proxies only the bounded direct-SFU session, SDP, track-pull, renegotiation, and close operations authorized by that assignment; Cloudflare application credentials never reach the worker. Bundle, progress, and finalization bodies report measurements against a server-owned assignment intent; they cannot select tenant, recording, object owner, or object key. The server loads the intent by job, attempt, fence, lease, and sequence, then rejects any size, checksum, content type, condition, or object fact that does not match it.

The current recorder worker router is a foundation to migrate, not the final contract: it lacks bootstrap, renewal, node observation, and transactional finalization; its bundle and artifact bodies still accept caller-selected tenant and object keys; and it is not mounted on a private listener. C0 freezes and implements this route migration before any worker is production-capable.

The listener requires TLS 1.3, a configured server certificate and private client CA, bounded headers and bodies, read/write/idle timeouts, graceful drain, and an independent readiness state. Missing recorder TLS configuration must prevent the private listener from starting outside local fixture mode without preventing the public API from reporting the configuration failure honestly.

Private payloads use a versioned JSON contract generated from the Go source-of-truth types. The checked-in schema covers assignment, object intent, authority renewal, worker events, bundle facts, artifact facts, transcription-source facts, and errors. Unbounded provider payloads, plaintext keys, media bytes, private provider identifiers, and reusable credentials never enter this contract or logs.

## Bootstrap and certificate lifecycle

One-time bootstrap assertions are created outside OpenTofu state and expire after five minutes. Each assertion binds environment, worker role, release digest, intended DigitalOcean Droplet, region, boot generation, nonce, and issuer generation.

The bootstrap flow is:

1. The node presents the assertion over the private bootstrap endpoint.
2. The control plane verifies signature, expiry, nonce, expected environment and role, release digest, region, boot generation, and live DigitalOcean inventory.
3. PostgreSQL consumes the nonce with compare-and-set so replay cannot issue another certificate.
4. The control plane issues a short-lived SPIFFE node certificate whose URI encodes environment, role, and opaque worker ID.
5. Removal, replacement, role change, release change, or inventory absence revokes the certificate and closes claims before a replacement can receive overlapping authority.

Certificate serial, worker ID, bound node, release, issuance, expiry, revocation state, and last use are durable control-plane facts. Workers receive no DigitalOcean token. Revocation must be enforceable on the private listener without waiting for the certificate's natural expiry.

## Assignment and authority envelope

A successful claim commits the lease before returning one immutable job authority envelope. The envelope contains:

- protocol version, job kind and ID, tenant/session/recording IDs, attempt, attempt limit, lease token, fencing generation, lease expiry, journey ID, `traceparent`, and `tracestate`;
- job authorization issue and expiry times, worker role, artifact class, and release-compatible payload version;
- capture session authority or render input manifest authority from the owning worker spec;
- versioned layout and media policy references;
- method-, object-key-, content-type-, byte-size-, conditional-write-, and expiry-scoped R2 intents;
- wrapped recording-key reference and bounded plaintext-key delivery authority without KMS credentials;
- terminal reporting, cleanup, and resource-use requirements.

Capture receives a rolling autonomy envelope of at most thirty minutes. Renewal starts when twenty-two minutes remain and must complete before twenty minutes remain. Renewal never changes job identity, attempt, fence, layout policy, or already committed object intents. If renewal fails, admission and replenishment stop; an existing capture may use only the authority already issued and must close its current bundle before expiry.

Render receives all bounded input intents, one conditional final-output intent, and key authority before processing starts. Control-plane loss cannot invalidate a valid in-flight write, but it cannot grant new work or overlapping attempts.

## Job transitions, retry, and dead letter

Claims use `FOR UPDATE SKIP LOCKED`, increment attempt and fencing generation, and commit before work begins. Heartbeat, progress, completion, retryable failure, terminal failure, cancellation, and recovery are compare-and-set transitions.

The proposed default heartbeat cadence is fifteen seconds, with a lease long enough to tolerate three missed heartbeats plus bounded network jitter. The worker renews the lease before half of the remaining lease window. Exact lease duration remains part of the open decisions below; it cannot exceed the authority envelope.

Retry delay is deterministic, bounded, and jittered by job ID. Capture defaults to five attempts and render to three. Exhausted work enters `terminal_failure`; operator requeue creates an audited new attempt decision and never edits immutable prior attempt facts.

Capture completion verifies its manifest and creates exactly one render job. Render completion calls `/finalize`, which verifies the final object and all transcription-source objects, commits the recording artifact, inserts the complete source manifest and chunk set, and creates one fenced transcription job per chunk in one database transaction. It creates no parallel recording authority and cannot leave a partial source or orphaned first job.

## Reservation, extension, and usage

Reservation creation and extension lock the capacity singleton and atomically evaluate:

- meeting, participant, bitrate, duration, and scheduled-window overlap;
- fresh capture pool health and qualified capture density;
- the render deadline schedule at or below ten nodes;
- tenant recording entitlement, funded usage exposure, and configured spend guard;
- the 20-meeting, 100-participant, 80-Mbps aggregate, and 120-minute ceilings.

Extension of a shorter reservation reserves only the additional bounded interval, render exposure, and usage exposure. It cannot extend past 120 minutes, past a policy or funding bound, or into an unqualified render schedule. Failure leaves the original reservation unchanged and returns a stable capacity or entitlement error. Warnings are emitted ten and two minutes before the accepted limit; capture stops at the limit while the meeting continues unrecorded.

The legacy public recording mutation surface cannot remain a parallel authority. Public callers may request recording through the reservation contract and read status, but cannot choose provider, storage key, lifecycle state, or final artifact identity.

## Scaler and reconciler

OpenTofu owns recorder policy, identity boundaries, firewalls, tags, KMS, R2, and hard limits. A bounded external control loop owns desired Droplets, replacement, drain, fencing, and scale-to-zero.

The capture scaler uses the ratified maximum-dimension formula and one ready spare. The render scaler uses earliest-deadline discrete packing with qualified per-job service time. Both clamp against environment, role, and global caps. Provider quota, stale inventory, failed scale action, or unqualified image closes new admission while preserving active nodes and leases.

The reconciler runs at a bounded cadence and on material events. It compares reservations, capacity, jobs, provider inventory, certificates, worker processes, leases, render deadlines, object facts, cleanup tombstones, and usage settlement. Each corrective action has an idempotency key, reason, observed generation, planned effect, result, and journey/trace context.

It detects expired leases, missing or overlapping bundle sequences, orphaned or partial objects, database/object mismatches, stale or revoked nodes, expired provider attempts, stranded work, missed render deadlines, and cleanup beyond one or twenty-four hours. It never creates overlapping attempts until prior authority is revoked or node termination is proven.

## Health, cleanup, and observability

Workers submit bounded node observations—process readiness, active jobs, resource headroom, certificate generation, and observation time—but cannot declare pool admission open. The reconciler is the only authoritative pool-health writer. It publishes capture and render role, admission-open state, ready capacity, bounded public-safe reason, observation time, release generation, and reconciler generation. This spec ratifies a two-minute maximum age for those rows. Public `/healthz/recorder/capture` and `/healthz/recorder/render` expose only `ok` or `unavailable`.

Normal verified finalization deletes temporary bundles and wrapped key material within one hour. The twenty-four-hour R2 lifecycle is an orphan backstop, not the normal path. By hour twenty-three, reconciliation commits the artifact or enters terminal render failure and schedules deletion. Partial uploads, multipart remnants, scratch media, expired URLs, revoked certificates, terminated nodes, and usage holds all have explicit cleanup facts.

Every admission, claim, renewal, heartbeat loss, fence, retry, certificate event, provider action, pool-health change, deadline, bundle, artifact, cleanup, and usage settlement propagates Chalk journey and W3C trace context. Metrics use bounded labels; logs contain no media, plaintext key, tenant-derived object key, certificate material, or unbounded provider error. Independent uptime and artifact canaries consume signed monitor results rather than trusting recorder self-report.

## Implementation phases and ownership

- [ ] **C0 — Contract freeze:** bootstrap and mTLS routes, schemas, assignment envelope, usage ownership, legacy route behavior, certificate lifecycle, finalization transaction, and error taxonomy are ratified. Generated private schemas and migration checks pass. Caller-selected bundle/artifact keys and worker-written pool health are removed.
- [ ] **C1 — Private listener and identity:** typed configuration, TLS listener, bootstrap issuance, nonce consumption, certificate storage/revocation, role gates, drain, and wire-level rejection tests pass.
- [ ] **C2 — Durable job authority:** claim, heartbeat, progress, renewal, completion, retry, dead letter, audited requeue, and capture-to-render transaction pass concurrent PostgreSQL tests.
- [ ] **C3 — Object and key authority:** scoped server-owned R2 intents, recording-key delivery, immutable inspection, `/finalize`, complete source/chunk seeding, one transcription job per chunk, and secret/redaction tests pass. Caller-selected tenant, key, owner, size, and condition fail negative tests.
- [ ] **C4 — Admission and extension:** the current always-unavailable extension stub is replaced; capacity, render schedule, usage exposure, positive and negative extension, warnings, no-show, and legacy-route migration pass atomic contention tests.
- [ ] **C5 — Scaler, reconciler, and health:** simulated provider inventory proves desired capacity, hard caps, scale failure, node loss, revocation, no overlapping attempts, fresh health, cleanup, and usage settlement.
- [ ] **C6 — Local end to end:** a clean topology runs reservation through capture, render, transcription, drain, restart, and database-backed recovery with observability proof and the full local gates.

The main thread owns shared contracts, migrations, integration, and final verification. Codebase explorers may inventory existing behavior; external researchers may confirm provider contracts; implementation remains in the main thread. Capture and render implementation may proceed in parallel only after C0 freezes their assignment and terminal handoffs. Staging qualification waits for C0–C6.

## Done and stopping point

This seam is done when C0–C6 have observed evidence, the private listener and all background loops run in the production-shaped local topology, capture and render workers exercise their real control contracts without direct database or reusable cloud credentials, the Go API and repository gates pass, generated contracts have no drift, and success plus failure paths are visible in traces, metrics, logs, monitors, and public-safe health.

Work stops before remote staging mutation. Provider capacity, real SFU media, GPU performance, and launch-ceiling evidence belong to the staging qualification spec. Production mutation is never authorized here.

## Open questions

1. Which existing domain owns the tenant recording entitlement and funded usage ledger, and what unit is reserved: maximum recording minutes, participant-minutes, captured input bytes, render minutes, or a composite exposure? C0 cannot pass until this is settled.
2. Should legacy `POST/PATCH /recordings` be removed, made read-only, or translated into the reservation contract during migration?
3. Which service issues and revokes recorder node certificates, and where should nonce consumption and revocation state live? C0 cannot pass until this is settled.
4. Do you accept the proposed fifteen-second heartbeat and three-miss failure threshold, or do you want a different lease cadence?
5. Should the private worker contract be emitted as OpenAPI, JSON Schema, or both?
