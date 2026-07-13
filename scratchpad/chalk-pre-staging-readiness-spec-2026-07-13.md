# Chalk Pre-Staging Readiness Spec

Status: Ratified staging-only implementation authority.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`.

Owner: Hasan Shoaib

Last reviewed: 2026-07-13

## Outcome

Finish every application, runtime, infrastructure, and monitoring artifact
needed to begin a staging deployment without inventing missing behavior during
the deployment. This spec ends before any remote staging resource is created or
changed. Staging activation, live-provider tests, failure drills, and production
work are separate later phases.

The handoff is complete when a fresh local machine can build the release, apply
the database migrations to an isolated test database, start the full local
topology, exercise its critical paths, and produce clean staging plans and
release artifacts.

## Current truth

| Area                       | What is complete                                                                                                                                                  | What remains                                                                                                                                                                                                         |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Transcription              | The track-aware job model, provider adapters, dispatcher, fallback, tests, and local debrief are committed.                                                       | Connect it to real recorder output; qualify provider privacy and limits; prove live failures and canaries later in staging.                                                                                          |
| Recording                  | The database model, state machine, reservations, usage holds, artifact jobs, worker foundations, and authenticated worker HTTP handlers exist in the shared tree. | Build real SFU capture and composite-render workers, run the worker surface on its dedicated mTLS listener, publish pool health, and close the legacy recording-authority hole.                                      |
| Sync                       | The v3 Stateholder and client work is largely implemented locally. Migration-range and external-consumer readiness fixes pass the full Sync gate.                 | Implement the private API provider-operation bridge, package the service, and prove the complete local flow.                                                                                                         |
| Go API                     | Existing product domains and the new recording/transcription foundations cover most business behavior.                                                            | Wire the worker control surface to its private listener; finish fail-closed staging configuration, meaningful readiness, release/schema reporting, graceful drain, deletion orchestration, and deployable packaging. |
| Runtime and infrastructure | Reusable low-level modules and a local telemetry stack exist.                                                                                                     | Build the staging OpenTofu roots, state and CI identity, container/runtime units, release controller, environment modules, plan policies, and recovery artifacts.                                                    |
| Monitoring                 | Local Grafana/OpenTelemetry configuration exists.                                                                                                                 | Build managed telemetry routing, independent component checks, signed monitor intake, alerts, status projection, and synthetic journeys.                                                                             |

“Complete” in this table means implementation exists and has local evidence. It
does not claim a provider-backed staging proof. Recording is deliberately not
marked complete: its foundation is present, but its real media workers are not.

## Implementation work

### 1. Platform API

- Add authenticated recorder-worker operations for claim, heartbeat, progress,
  completion, failure, bundle and artifact reporting, and pool health; mount
  them behind the worker identity and mTLS boundary.
- Make the recorder service the only recording-state authority. Public legacy
  recording writes must not let callers choose storage keys, providers, or
  lifecycle states.
- Validate every staging setting before listening: release identity, origins,
  database roles and pool budgets, worker trust, providers, storage, telemetry,
  rate limits, and shutdown limits.
- Make readiness prove database access, compatible schema, release identity,
  required background loops, and required provider configuration.
- Drain honestly: fail readiness first, stop new work, finish bounded in-flight
  work, and then exit.
- Implement tenant and user deletion, tombstones, retention, and restore rules
  across the API, Sync state, recordings, transcripts, and object storage.

### 2. Sync

- Treat the Sync migration version as a minimum compatible floor so later
  additive API or recorder migrations do not make a healthy database fail
  readiness.
- Include the external-operation consumer in readiness and report whether it is
  absent, dead, or stale.
- Send media and recording operations to the Go API through a private,
  versioned, mutually authenticated interface. Sync owns the durable intent,
  authorization, fence, retry schedule, and final user-visible result. The API
  alone owns provider selection, credentials, provider calls, reconciliation,
  recording admission, and durable execution receipts. Nil runtime adapters and
  permanently pending operations are not acceptable.
- Persist idempotent API execution receipts and a monotonic media-observation
  journal. Implement the Cloudflare grant, revoke, remove, end, and observation
  operations plus recorder start and stop behind that boundary. Ambiguous
  provider results must reconcile before replay instead of blindly repeating an
  effect.
- Produce the non-root release image and complete startup, shutdown, recovery,
  resource-limit, and release-metadata behavior.

### 3. Recording and transcription integration

- Replace fixture-only capture with a worker that joins the authorized SFU,
  captures bounded tracks and timeline data, uploads immutable bundles, renews
  its lease, and reports a fenced terminal result.
- Replace fixture-only rendering with deterministic composite rendering,
  bounded scratch storage, artifact verification and upload, lease renewal, and
  fenced terminal reporting.
- Run a production-shaped pool-health writer and reconciler so admission is
  based on current capacity rather than manually inserted rows.
- Either implement the required Cloudflare extension path or ratify its removal;
  the current always-unavailable behavior cannot ship unnoticed.
- Feed real recorder artifacts and speaker-turn manifests into the committed
  transcription dispatcher without creating a second job or transcript
  authority.

### 4. Runtime, release, and infrastructure code

- Build digest-addressed API and Sync images and the rootless Podman/Quadlet
  runtime, cloudflared unit, watchdog, migration unit, and host bootstrap.
- Create the OpenTofu bootstrap, foundation, and staging environment roots with
  remote state, short-lived CI identity, imports for preserved resources,
  provider modules, secret references, and deletion protection.
- Create one immutable release manifest covering source revision, image and web
  digests, schema compatibility, protocol versions, and provenance. Implement
  deploy, rollback, replacement, and evidence recording against that manifest.
- Add plan checks for environment isolation, public exposure, destructive
  changes, required tags, fixed-cost limits, and usage-based capacity.
- Produce clean plans only. This phase does not apply them.

### 5. Monitoring, status, and cost controls

- Route API, Sync, recorder, transcription, host, and tunnel telemetry to the
  environment's managed observability stack with bounded labels and redaction.
- Build independent API, Sync, recording, transcription, database, tunnel, and
  web checks. The status system must consume signed, fresh results and must not
  depend only on the system it monitors.
- Define alerts, recovery notifications, synthetic journeys, dashboards, and
  public-safe component projection as code.
- Add the dated estimator and usage ledger that enforce fixed-cost warnings,
  the combined ceiling, per-recorded-hour metering, and staging activation
  leases.

## Review, verification, and test work

These checks prove the implementation above; they are not substitute
implementation tasks.

- Run focused unit and integration tests in each owning package, then the Go API
  gate, Sync gate, SDK tests, infrastructure validation, and the repository gate.
- Start the production-shaped local topology from a clean build and prove API
  startup, a two-client Sync session, recording reservation, worker claim and
  fencing, fixture media through capture/render/transcription, graceful drain,
  restart, and database-backed recovery.
- Apply every migration to a fresh isolated PostgreSQL database, then prove the
  API and Sync accept the resulting compatible schema and reject an older one.
- Build all images and release artifacts twice and verify their recorded digests
  and compatibility metadata.
- Generate staging OpenTofu plans and prove policy checks catch a destructive
  change, a public origin, a production target, and a cost-limit violation.
- Review secret flow and logs to prove no reusable credential, customer content,
  private provider identifier, or full connection URL enters the repository,
  image, telemetry, or evidence bundle.

Provider account permissions, quotas, regions, pricing, and compliance terms
must be inventoried before staging, but live traffic and failure drills belong
to staging qualification. A provider prerequisite that cannot be checked
read-only is recorded as a staging blocker rather than simulated locally.

## Work lanes and ownership

| Lane                | Owns                                                                      | Hands off                                        |
| ------------------- | ------------------------------------------------------------------------- | ------------------------------------------------ |
| API control         | Worker HTTP control, authority, configuration, readiness, drain, deletion | Stable worker and operational contracts          |
| Sync state          | Stateholder, external-operation execution, readiness, packaging           | Stable operation and release contracts           |
| Media workers       | Real capture, render, pool health, recorder/transcription bridge          | Bundles, artifacts, health, and terminal reports |
| Runtime and release | Images, host runtime, manifest, deployment and rollback controller        | Reproducible local release                       |
| Staging IaC         | State, identity, provider modules, environment plan and policies          | Reviewed no-apply staging plan                   |
| Operations          | Telemetry, monitors, alerts, status, synthetics, cost and evidence        | Local checks and managed configuration artifacts |

Each lane owns distinct files. Shared contracts are fixed by the orchestrating
thread before dependent work starts. A lane is done only when its focused tests
pass and its handoff contract is exercised by its consumer.

## Completion gate

Pre-staging readiness is done only when every implementation item is present,
the full local topology and repository gates pass, release artifacts are
reproducible, staging plans are clean and policy-checked, and every remaining
item explicitly requires remote staging evidence rather than more code.

The next phase may then create staging resources and perform live verification.
This document never authorizes production work.
