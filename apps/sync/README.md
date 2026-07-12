# Chalk Sync Server

Elixir/OTP WebSocket sync server and the primary `SyncEngine` adapter.

Postgres is the sole durable authority for Session control state, ordered
events, command receipts, participant-session lifecycle, and lifecycle delivery
intents. Every BEAM process, ETS table, notification, and SDK replica is a
disposable projection. Redis is absent from the correctness path and may only
be added later as an optional presence or head-hint accelerator.

## Commands

```bash
mix deps.get
mix test
iex -S mix
scripts/gate.sh
scripts/sync-breaker-v2 --help
```

Development listens on `http://localhost:4100`. The interactive lab at
`/dev/lab` exercises the legacy development surface. Production disables that
surface and protocol v1.

## Durable architecture

The v2 command path is:

```text
WebSocket
  -> bounded command admission
  -> node-local Session coordinator
  -> semantic Postgres transaction
  -> folded state + exact-next event + stable receipt
  -> Postgres head notification
  -> bounded per-socket queue
  -> SDK canonical replica
```

The authority key is `{tenant_id, session_id}`. The Session control row is the
serialization lock. One transaction returns a committed event and receipt or a
stable rejected receipt. An uncertain COMMIT is resolved by reading that
receipt from a fresh writable-primary connection.

`Sessions.Reducer` owns pure state transitions. `Stateholder.Postgres` owns
production decisions and recovery. `Sessions.Coordinator` caches only local
heads and subscriptions. PostgreSQL notifications accelerate delivery, while a
periodic authoritative head read repairs every dropped hint.

## Lifecycle

Session creation writes the product Session and revision-zero control row in
one synchronous Postgres transaction. Participant admission, explicit removal,
and Session end are API-generated, idempotent lifecycle intents. The sync
consumer applies each intent through the same Session control lock. Opening or
losing a socket never creates a durable join or leave.

## Protocol v2

The language-neutral source is `contract/schema/sync-v2.json`; generated
Elixir and TypeScript bindings are checked by the root codegen gate. V2 has
strict frame bounds, tenant/Session-scoped identity, stable command IDs,
digest-checked cursors, snapshot/replay/up-to-date recovery, bounded replay
pages, retryable dependency outcomes, explicit terminal lifecycle results, and
cumulative live delivery acknowledgments. A live frame keeps its event, byte,
and age reservation until the SDK confirms the exact applied revision and
state digest. Snapshot welcomes and replay pages retain the same reservations
until an exact `recovery_ack` confirms successful client application, so a slow
transport cannot hide work beyond the socket bounds.

V1 remains only as a local compatibility surface while callers migrate. It is
disabled by production configuration and is outside the production durability
claim.

## Operations

- `/healthz` proves the listener is alive.
- `/readyz` applies dependency checks and readiness hysteresis.
- `/metrics` exposes fixed-cardinality aggregate counters.
- SIGTERM begins bounded drain, rejects new work, resolves accepted decisions,
  drains socket queues, and closes clients with retryable code 1012.
- Ended Session history is independently folded and checkpointed before the
  bounded retention worker deletes eligible rows after seven days.

Production boot refuses Memory, the development verifier, an incompatible
migration, a non-writable database, and a missing required synchronous standby.
The exact launch topology and WAL-lag ceiling remain deployment inputs.

## Verification

The deterministic v2 breaker writes replayable artifacts under the ignored
`apps/sync/.artifacts/` directory. Real-Postgres semantic tests, independent
multi-node tests, transport bounds, browser/runtime proofs, lifecycle tests,
failover drills, and the repository gates define the production claim. See
`scratchpad/sync-production-readiness-spec-2026-07-11.md` for the complete
acceptance contract.
