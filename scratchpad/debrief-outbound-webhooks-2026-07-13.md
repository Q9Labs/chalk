# Outbound webhooks debrief

## Grand summary

Phases 1–3 now have a durable PostgreSQL outbox, tenant-scoped management API,
signed and retried dispatcher, authoritative Sync producers, generated client
contracts, a server-only TypeScript receiver processor, and linked operational
telemetry. The implementation is solid in focused verification but needs
attention before launch: the public v3 lifecycle path cannot complete Host
recovery, the canonical gates are red in concurrent v3 code, and the final live
proof reaches six rather than all eight core Events. Production additionally
requires independent KMS envelope custody and deletion/restore reconciliation.

## Walkthrough

- Start with `contract/webhooks/v1/event.schema.json:1` and
  `contract/webhooks/v1/fixtures.json:1`: these define the integer
  `api_version`, `event` envelope, all version-1 bodies, canonical bytes, and
  the source used by Go, Elixir, and TypeScript.
- Read `apps/api/db/migrations/20260712223000_add_outbound_webhooks.sql:12` for
  the seven-record persistence model: tenant claim rotation, Endpoints,
  immutable target revisions, Events, Deliveries, Attempts, and idempotency
  replay records. Tenant-composite keys, revision fences, leases, retention,
  and erasure state are enforced here rather than by convention.
- Continue at `apps/api/internal/webhooks/service.go:27` for management behavior
  and `apps/api/internal/httpapi/webhooks.go:130` for the ten protected `/v1`
  operations, including one-time secret visibility, optimistic concurrency,
  inspection, rotation, test, and retained-Event redelivery.
- The delivery path starts at `apps/api/internal/webhooks/dispatcher.go:83`.
  Claims are durably fair across tenants and Endpoints; each Attempt performs a
  fresh SSRF/DNS decision, pins the allowed address, signs immutable raw bytes,
  records a content-free result, retries deterministically, and terminates its
  journey branch.
- API-owned lifecycle fanout is attached in
  `apps/api/internal/adapters/postgres/session_lifecycle_create.go:84` and the
  Room repository. The Event and every matching Delivery commit in the same
  product transaction, so a crash cannot separate the customer mutation from
  its webhook fact.
- Sync-owned lifecycle fanout enters through
  `apps/sync/lib/chalk_sync/webhooks/producer.ex:24` at original external-
  operation finalization and through `producer.ex:10` for accepted lifecycle
  intents. `apps/sync/lib/chalk_sync/external_operation_consumer.ex:20`
  supervises only locally authoritative Leave/end operations; provider-backed
  work remains untouched.
- The receiver boundary begins at
  `sdks/typescript/client/src/webhooks/verify.ts:206` and
  `processor.ts:191`. It verifies Standard Webhooks signatures over raw bytes,
  accepts overlap secrets, validates generated Event types, coordinates a
  customer-owned inbox lease, narrows typed handlers, contains observers, and
  returns bounded safe HTTP outcomes. It ships only through server/edge
  `./webhooks` and test-only `./webhooks/test` package subpaths.
- Operational evidence is defined in `docs/observability.md:55`, with the
  dispatcher continuing the producing journey through linked Attempt traces.
  `infrastructure/observability/grafana/provisioning/alerts.yaml:509` adds the
  signed canary alert alongside backlog, p99, exhaustion, lease, stuck-branch,
  and cleanup rules.
- The executable story is
  `infrastructure/observability/scripts/e2e-webhook.mjs:21`. It exercises the
  real management API, HTTPS receiver, first-attempt 503, restart recovery,
  duplicate redelivery, local production-mode Sync, and journey/telemetry
  assertions. The current run stops at `startV3Client` around line 294, before
  Leave/end can be accepted.

## Findings

### Blocker — correctness: public v3 lifecycle bootstrap and recovery are incomplete

`apps/api/internal/adapters/postgres/session_lifecycle_create.go:141` creates an
admitted Participant without the Host/eligible-role state required by v3, while
the API-created control snapshot also predates the exact schema-v3 fold required
by `apps/sync/lib/chalk_sync/sessions/reducer.ex:143`. A narrowly scoped local
fixture proves `participant.joined`, but the Host client still never observes
WebSocket recovery, so no public Leave/end operation is accepted. The v3 owner
should make Session creation emit the canonical schema-v3 snapshot, establish
exactly one Host through the public admission contract, add a diagnostic result
for failed hello/recovery, and prove Host plus guest recovery before this launch
gate is rerun.

### Blocker — verification: canonical gates are red in the concurrent v3 slice

`apps/api/internal/adapters/postgres/session_lifecycle_requests.go:134` and its
integration fixtures still target legacy `session_ended` lifecycle intents,
which violate the current v3 constraint in
`apps/api/db/migrations/20260712233000_add_declarative_sync_v3.sql:133`. The Sync
gate also stops on nine strict Credo findings in generated-v3 validation and the
reducer; the repository audit reports 30 v3 complexity findings and six v3
clone groups. The v3 implementation must route public Leave/end through durable
external operations, update the stale tests, and make generated output pass
the repository static contract. Until all three gates pass, this change must
remain uncommitted and cannot receive the required commit review.

### Major — security: production key custody is still process-local

`apps/api/internal/webhooks/protector.go:41` correctly uses versioned
AES-256-GCM keys with tenant/resource associated data, but
`apps/api/internal/config/config.go:421` loads the whole decryptable keyring into
the API process. That is acceptable for local and staging verification, not
independent production custody. Replace it with a KMS-backed envelope provider
that owns wrapping, rotation, re-encryption, and retirement before enabling the
feature in production.

### Major — privacy/recovery: erasure is implemented but not orchestrated

`apps/api/internal/adapters/postgres/webhook_erasure.go:15` atomically destroys
user-linked bodies and fences every affected Delivery, but no public
user-deletion caller invokes it and no durable external tombstone is reapplied
after restore. Wire this primitive into deletion before the User row is removed,
persist an authority outside the restored webhook tables, and block claims until
restore reconciliation replays every tombstone.

### Major — performance: the launch-load dispatcher SLO lacks end-to-end proof

The required API profile passes, but its endpoint inventory does not exercise
webhook dispatch or the 60-second first-Attempt SLO under qualified fanout load.
Focused PostgreSQL tests prove tenant rotation, Endpoint caps, retry, and lease
recovery, while the dashboard exposes p99 latency; neither is a sustained
dispatcher load test. Add a bounded multi-tenant fanout drill with slow and
failing receivers, then assert first-Attempt p99, fairness, database load, and
recovery after worker restart before core launch.
