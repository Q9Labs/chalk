# Chalk API Staging Readiness Spec

Status: Requirements source. Execution is governed by
`scratchpad/chalk-pre-staging-readiness-spec-2026-07-13.md`, which separates
pre-staging implementation from live staging verification.

Parent: `scratchpad/chalk-infrastructure-readiness-spec-2026-07-11.md`.
Its settled decisions, environment boundaries, data ownership, recovery targets,
approval rules, and anti-slop rules bind this spec.

Owner: Hasan Shoaib

Last reviewed: 2026-07-13

## Purpose and scope

This spec defines the remaining Go API work required to boot, operate, replace,
and verify Chalk staging. The API already contains the product domains for
authentication, users, tenants, memberships, rooms, sessions, Sync tokens,
recordings, transcripts, audit logs, webhooks, media-plane access, object
storage, telemetry, rate limiting, and authorization. This is a readiness and
integration specification, not a rewrite of those domains.

The implementation must preserve the existing hexagonal boundaries in
`apps/api`: public HTTP contracts call domain services, services call ports and
repositories, and provider or PostgreSQL details remain in adapters. Normal
public routes stay under `/v1`; operational routes remain unversioned.

## Ownership boundary

Recording and transcription are being implemented in separate lanes. Their
state machines, artifact-job schema, worker protocol, capture and render
behavior, transcription adapters, and domain-specific acceptance tests remain
owned by:

- `scratchpad/chalk-recorder-pipeline-spec-2026-07-12.md`; and
- `scratchpad/chalk-transcription-spec-2026-07-12.md`.

The API lane integrates the reviewed contracts those lanes produce. It may add
composition-root wiring, shared authentication, authorization, rate limits,
configuration, database-pool allocation, health projection, release metadata,
telemetry, and deployment tests. It must not independently invent a second
recording state machine, transcript authority, job table, lease protocol,
worker credential, or object-key convention.

When a recorder or transcription contract is missing or contradictory, the API
worker records the exact interface issue and stops that integration seam. It
does not resolve the ambiguity by creating an API-only behavior.

## Required outcome

The same immutable Go API image runs locally and in staging. A clean staging
activation validates its complete environment, connects with the runtime
database role, reports honest health, serves the expected release, survives
bounded dependency failures, drains cleanly, and reconstructs on a replacement
node without node-local state. Database migrations run separately with a
migrator role and prove compatibility before traffic reaches the release.

Staging is the only remote target authorized by this spec. No production
resource, secret, database, domain, deployment, or provider configuration is
created or modified during this work.

## Configuration contract

One typed configuration load validates the complete staging contract before the
HTTP listener opens. It covers:

- environment and release identity;
- public web, API, Sync, and callback origins;
- direct PlanetScale PostgreSQL runtime connectivity and pool budgets;
- optional Redis acceleration, with loss excluded from correctness;
- the selected Cloudflare SFU credentials and provider-neutral media-plane
  selection;
- the staging R2 bucket, object URL policy, and signing boundary;
- OpenTelemetry export, sampling, service identity, and environment identity;
- authentication, cookies, CORS, trusted proxy, rate-limit, and shutdown
  settings; and
- recorder and transcription integration settings supplied by their lanes.

Local development may use explicit local defaults. Staging has no insecure or
silent provider defaults: missing credentials, placeholder origins, disabled
TLS, unknown providers, malformed durations, invalid pool budgets, or a
production hostname fail startup with a redacted, actionable error. Validation
must never print a secret or a full connection URL.

The API derives `environment=staging` from trusted deployment configuration. A
caller, worker, request header, telemetry label, or database row cannot promote
itself into another environment.

## Image and process lifecycle

The API ships as a digest-addressed, non-root Linux image for both supported
architectures. The image contains only the runtime binary and required trust or
timezone material; it contains no source tree, build toolchain, credentials,
migration authority, mutable release tag, or recorder/transcription runtime.

Startup follows one observable sequence:

1. parse and validate configuration;
2. initialize telemetry without exposing secrets;
3. open bounded dependency clients and the runtime database pool;
4. prove required startup dependencies within bounded timeouts;
5. construct services and routes;
6. open the listener; and
7. become ready only after the deployed schema and release compatibility checks
   pass.

On `SIGTERM`, readiness becomes false before draining begins. The server stops
accepting new work, gives in-flight HTTP requests and owned background loops a
bounded drain window, flushes telemetry within its own smaller bound, closes
clients, and exits zero. Forced termination after the bound must not corrupt a
database transition or leave an unbounded goroutine.

## Health and release identity

The API exposes three operational facts without authentication or sensitive
detail:

- `/healthz` reports only whether the API process and its event loop can serve a
  response. Provider or database failure does not make liveness fail and trigger
  a replacement loop.
- `/readyz` reports whether the instance may receive traffic. Its stable machine
  response distinguishes required, degraded, and optional dependencies without
  including hosts, account IDs, credentials, database names, or raw errors.
- a release endpoint, or an explicitly safe release block in readiness, reports
  the immutable release ID, build revision, contract/schema compatibility
  version, and startup time.

PostgreSQL is required. Redis is optional. A provider is required only when the
enabled request path cannot operate safely without it. A transient external
provider outage should normally degrade that capability and alert rather than
make the whole instance unready. The dependency matrix is table-driven and
tested so adding a client cannot silently change replacement behavior.

## Network and HTTP security

The origin remains reachable only through Cloudflare Tunnel. The API trusts
forwarding headers only when the direct peer is inside the explicitly configured
cloudflared boundary; direct or malformed forwarding headers are ignored. Rate
limits, audit records, and security telemetry use the resulting canonical
client address without storing unnecessary raw address history.

The server configures bounded headers and bodies plus read, write, idle, and
header timeouts. Debug and profiling routes cannot be enabled outside local
development. CORS accepts only the staging web origin and reviewed local
origins. Staging cookies use the intended secure, domain, path, SameSite, and
expiry policy. OAuth callbacks, signed URLs, and redirects reject unapproved
hosts and schemes.

Every `/v1` route is authenticated unless its endpoint contract explicitly
declares it public. Every tenant resource performs authorization after parsing
the tenant and resource identifiers. Protected routes prove `401` for an
anonymous caller and `403` for an authenticated caller from the wrong tenant.
Writes have explicit body limits, stable errors, idempotency where retries can
duplicate intent, and bounded rate limits.

## Database and migration contract

The API uses separate PlanetScale roles:

- the runtime role has only the data permissions needed by the running API and
  cannot change schema; and
- the migrator role uses the direct PostgreSQL endpoint, never PgBouncer, and is
  available only to the bounded deployment migration step.

API startup never applies migrations. Goose migrations and their immutable
checksums are the operational history; `db/schema.sql` remains the reviewed
snapshot. Every schema change updates migrations, the snapshot, sqlc queries,
generated code, and compatibility metadata together.

Before a release becomes ready, a read-only compatibility check proves that the
live migration head lies inside the release's declared compatibility range. A
deployment runs migrations once, records the before and after heads, then runs a
live smoke test using the runtime role. A migration failure leaves the previous
release serving and blocks promotion. Rollback never executes an unsafe `Down`
path merely to make automation green.

The runtime pool has an explicit total budget subdivided among request traffic,
Sync-facing control work, recorder/transcription control work, background
reconciliation, health checks, and a safety reserve. Saturation sheds bounded
work and emits telemetry; it does not create unbounded connection attempts.

The existing PlanetScale database may be adopted for staging only after its
engine, region, version, plan, consumers, branches, roles, backups, schema, and
data classification are inventoried. Existing data is exported to a verified
private destination before destructive cleanup. Adoption stops if the database
cannot be proven staging-only, PostgreSQL, Singapore-hosted, and compatible with
the required migration history.

## Dependency failure behavior

All outbound calls have explicit connect, request, and total timeouts. Retries
are limited to failures known to be safe, use bounded backoff with jitter, honor
provider retry guidance, and preserve the request's idempotency and deadline.
One request cannot keep retrying after the caller or shutdown context is done.

The expected behavior is:

| Dependency failure                             | API behavior                                                                                                                                                                       |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PostgreSQL unavailable                         | Reject database-backed work quickly, remain live, become unready, and recover without restart when connectivity returns.                                                           |
| Redis unavailable                              | Continue from PostgreSQL-backed truth or return a bounded retry for acceleration-only functions; never lose durable correctness.                                                   |
| Cloudflare media API unavailable               | Preserve durable room/session intent, stop unsafe new media mutations, reconcile later, and keep unrelated API routes available.                                                   |
| R2 unavailable                                 | Stop issuing unusable artifact operations, preserve PostgreSQL intent and tombstones, retry or reconcile within the owning artifact contract, and keep unrelated routes available. |
| Recorder or transcription executor unavailable | Close new work according to the owning admission contract, preserve leased work and terminal visibility, and keep meetings and committed artifacts available.                      |
| Telemetry exporter unavailable                 | Continue serving, buffer only within a fixed memory bound, count drops, and surface pipeline failure through independent monitoring.                                               |

Provider errors are translated into stable domain errors. Responses, logs,
traces, metrics, audit entries, and journey events never include credentials,
provider payloads, signed URLs, media, transcript contents, or raw database
errors.

## Data lifecycle and deletion orchestration

PostgreSQL is the authority for deletion intent and tombstones. A user or tenant
deletion request atomically prevents new access, records the affected data
classes, and creates retryable deletion work. Background reconciliation drives
each owned provider and object deletion to a verified terminal result.

The API lane owns the common orchestration, authorization, audit trail,
idempotency, expiry scheduling, pseudonymization, tombstone replay after
restore, and operator-visible failure state. Recording and transcript object
rules remain owned by their companion specs and plug into this orchestration.
Deleting a database row before its external bytes are verified absent is not a
successful deletion.

Restore tests prove that a backup cannot resurrect access to deleted users,
sessions, recordings, transcripts, or provider objects: restored tombstones are
replayed before the restored environment can become ready. Legal hold remains
unavailable at launch and no API response implies otherwise.

## Observability contract

The API follows `docs/observability.md`. It accepts or creates a `journey_id`,
propagates W3C trace context through services, repositories, async work, Sync,
and provider adapters, and records user-visible lifecycle transitions in the
durable journey ledger. Late callbacks and independent fan-out use span links
rather than false parentage.

Every meaningful success, rejection, retry, timeout, dependency degradation,
lease recovery, deletion failure, readiness transition, and shutdown outcome is
visible through bounded-cardinality metrics, structured logs, and traces. The
release and environment are server-derived attributes. Tenant IDs, room IDs,
job IDs, command IDs, raw revisions, signed URLs, and user-provided values are
not metric dimensions.

## Contract and consumer integrity

Every normal public route uses the endpoint contract pattern and appears in the
generated OpenAPI document and TypeScript SDK. Route changes regenerate and
commit the OpenAPI contract, Effect schemas, generated client, and generated
Effect `HttpApi`. The generated drift check is non-mutating and remains green.

The API lane does not declare a route complete until a realistic consumer can
call it, its authentication and authorization failures are tested, and its
success and operational failure are visible in the execution trace harness and
the observability proof.

## Staging verification

The API is verified against the real staging boundaries, not only unit tests:

1. Build both image architectures and run the selected staging architecture as
   a non-root user.
2. Start from a clean database, apply migrations with the migrator role, and
   prove the runtime role cannot execute DDL.
3. Boot with the exact staging release and prove invalid, missing, local, and
   production configuration fails before listening.
4. Exercise authentication, tenant authorization, rooms, sessions, Sync-token
   issuance, media-plane control, webhooks, audit logs, and the recorder and
   transcript contracts supplied by their lanes.
5. Verify `/healthz`, `/readyz`, release identity, Cloudflare client address,
   CORS, cookies, body limits, timeouts, and rate limits through the public
   staging origin.
6. Inject each dependency failure in the matrix and prove the stated degraded,
   unavailable, alerting, and recovery behavior.
7. Send `SIGTERM` during ordinary requests and owned background work; prove
   readiness drops first, requests drain within the bound, and restart requires
   no repair.
8. Replace the complete app node and prove the same release reconstructs from
   PostgreSQL, provider state, and environment configuration without node-local
   state or Redis correctness.
9. Run deletion, backup restore, tombstone replay, and provider/object absence
   checks for every retained API-owned data class.
10. Run `apps/api/scripts/gate.sh`, `apps/api/scripts/perf-local.sh`, the relevant
    root gate, SDK drift checks, execution trace scenarios, and the local and
    staging observability proofs.

The performance proof uses the parent spec's workload, latency, connection, and
capacity thresholds. This companion does not restate or weaken those numeric
limits.

## Implementation checklist

Evidence belongs in the infrastructure execution ledger. Tick a box only after
the linked behavior has been observed.

- [ ] Current API routes, background loops, migrations, configuration, and
      provider clients audited against this spec.
- [ ] Recorder and transcription interface manifests accepted without parallel
      API-only state machines or job contracts.
- [ ] Typed staging configuration fails closed and redacts secrets.
- [ ] Non-root multi-architecture image and bounded startup/shutdown proven.
- [ ] Honest liveness, readiness, dependency classification, and release
      identity proven.
- [ ] Trusted cloudflared client-address handling, HTTP bounds, CORS, cookies,
      authentication, authorization, idempotency, and rate limits proven.
- [ ] Runtime and migrator roles, migration compatibility, pool budgets, and
      failed-migration behavior proven.
- [ ] Existing PlanetScale staging adoption or clean creation verified with a
      private backup and no unreviewed data loss.
- [ ] Provider timeout, retry, degradation, reconciliation, and recovery matrix
      proven.
- [ ] API-owned deletion orchestration and restored-tombstone replay proven.
- [ ] OpenAPI, SDK generation, trace harness, journey ledger, metrics, logs,
      traces, alerts, and redaction checks proven.
- [ ] Public staging smoke, process restart, full node replacement, and complete
      API gate passed.

## Done and stopping point

This spec is done when every checklist item has evidence in the execution
ledger and the staging API passes the verification sequence through its public
origin. Work stops with a deployable, recoverable staging API and its reviewed
interfaces to the separately implemented recorder and transcription lanes.

Deliberately out of scope: production mutation, production credentials,
production data migration, a second API architecture, a new queue or database,
moving recorder or transcription execution onto the app node, redesigning the
ratified artifact pipeline, acoustic diarization, and unrelated API product
features.
