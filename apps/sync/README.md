# Chalk Sync Server

Elixir/OTP WebSocket sync server and the primary `SyncEngine` adapter.

Postgres is the sole durable authority for Episode control state, ordered
events, command receipts, participant-episode lifecycle, lifecycle intents,
and externally effective operation intents. Actual media publications remain
MediaPlane truth. Every BEAM process, ETS table, notification, and SDK replica
is a disposable projection. Redis is absent from the correctness path and may
only be added later as an optional presence or head-hint accelerator.

## Commands

```bash
mix deps.get
mix test
iex -S mix
scripts/gate.sh
```

Development listens on `http://localhost:4100`. The development server
exposes the same v1 WebSocket transport used by the production service.

## Local parity

The root `pnpm dev` profile runs Sync with `MIX_ENV=prod` and
`CHALK_SYNC_LOCAL_PARITY=true`. Sync uses the migrated local Postgres database,
verifies API-issued Ed25519 JWTs, binds to `127.0.0.1`, and reaches the Go API
through the generated local mutual-TLS provider bridge. The runtime creates
those signing and certificate identities under `.private/chalk-dev/`; no
manual key or environment-file setup is needed.

This path is distinct from `CHALK_SYNC_LOCAL_PROOF`: it does not use memory
state or the development token verifier. `/readyz` checks the Postgres and
provider-bridge dependencies before the root command reports ready.

## Durable architecture

The v1 command path is:

```text
WebSocket
  -> bounded command admission
  -> node-local Episode coordinator
  -> semantic Postgres transaction
  -> folded state + exact-next event + stable receipt
  -> Postgres head notification
  -> bounded per-socket queue
  -> SDK canonical replica
```

The authority key is `{tenant_id, episode_id}`. The Episode control row is the
serialization lock. One transaction returns a committed event and receipt or a
stable rejected receipt. An uncertain COMMIT is resolved by reading that
receipt from a fresh writable-primary connection.

`Episodes.Reducer` owns pure state transitions. `Stateholder.Postgres` owns
production decisions and recovery. `Episodes.Coordinator` caches only local
heads and subscriptions. PostgreSQL notifications accelerate delivery, while a
periodic authoritative head read repairs every dropped hint.

## Lifecycle

Episode creation writes the product Episode and revision-zero control row in
one synchronous Postgres transaction. Admission produces bounded lifecycle
intents. Removal, explicit Leave, host recovery, deadline expiry, Recording,
and Episode end reserve idempotent external operations under the same Episode
control lock, execute provider effects outside the transaction, and finalize
durable facts only after confirmation. Opening or losing a socket never creates
a durable join or leave.

## Protocol v1

The language-neutral source is `contract/schema/sync-v1.json`; generated
Elixir and TypeScript bindings are checked by the root codegen gate. V1 has
strict frame bounds, tenant/Episode-scoped identity, stable command IDs,
digest-checked control cursors, snapshot/replay/up-to-date recovery, bounded
replay pages, retryable dependency outcomes, and explicit terminal lifecycle
results. Control events retain their event, byte, and age reservations until
the SDK confirms the exact applied revision and state digest. Snapshot welcomes
and replay pages retain the same reservations until an exact `recovery_ack`
confirms successful client application. Media and presence recover with fresh
bounded projection snapshots, then change through exact-next events; disabled
publications and disconnected presence are explicit tombstones. MediaPlane
observations carry monotonic incarnation/sequence cursors so stale provider
snapshots cannot overwrite newer truth.

## Operations

- `/healthz` proves the listener is alive.
- `/readyz` applies dependency checks and readiness hysteresis.
- `/metrics` exposes fixed-cardinality aggregate counters.
- SIGTERM begins bounded drain, rejects new work, resolves accepted decisions,
  drains socket queues, and closes clients with retryable code 1012.
- Ended Episode history is independently folded and checkpointed before the
  bounded retention worker deletes eligible rows after seven days.

Production boot refuses Memory, the development verifier, an incompatible
migration, a non-writable database, and a missing required synchronous standby.
The exact launch topology and WAL-lag ceiling remain deployment inputs.

Production protocol-v1 admission verifies API-issued Ed25519 JWTs locally. Set
`CHALK_SYNC_TOKEN_ISSUER`, `CHALK_SYNC_TOKEN_AUDIENCE`, and
`CHALK_SYNC_TOKEN_PUBLIC_KEYS`; the last value is a JSON object mapping each
accepted `kid` to an unpadded base64url 32-byte Ed25519 public key. Rotation
renders both public keys before the API begins signing with the new `kid`.

Production durable media operations use the API's private provider bridge over
TLS 1.3 with mutual certificate verification. Set
`CHALK_SYNC_PROVIDER_BRIDGE_URL` to the private HTTPS origin and provide the
client certificate, unencrypted private key, and trusted CA PEM paths through
`CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE`, `CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE`, and
`CHALK_SYNC_PROVIDER_BRIDGE_CAFILE`. Production startup fails when any value or
PEM file is missing or malformed, and readiness actively verifies the mTLS-only
bridge endpoint. The seven-second bridge request budget remains shorter than the
eight-second durable-operation consumer budget.

## Observability

`ChalkSync.Observability` provides the observability boundary. It emits stable
`:telemetry` events, correlated Logger metadata, and
short OpenTelemetry spans. It does not retain a connection-long span. Socket
work uses root, phase, and terminal events; Episode-coordinator work links back
to the originating socket span after crossing the OTP process boundary.

Set `CHALK_SYNC_OTLP_ENDPOINT` to enable OTLP HTTP/protobuf export. The
service resource name is `chalk-sync`; the exporter is otherwise disabled.
The batch processor isolates collector failures from space and socket work.

```bash
CHALK_SYNC_OTLP_ENDPOINT=http://localhost:4318 mix run --no-halt
```

The stable telemetry event name is `[:chalk_sync, :observability, :event]`.
Its measurements are `%{count: 1}` and its metadata contains `event`, `stage`
(`root`, `phase`, or `terminal`), `journey_id`, and bounded `attributes`.
BEAM health uses `[:chalk_sync, :runtime, :health]` with memory, process, and
run-queue measurements. Logger events include the journey and, when tracing is
enabled, the trace and span identifiers. Tokens, space ids, participant ids,
command ids, and raw revisions are never observability dimensions.

Client and server protocol frames may carry these optional top-level fields
without changing frame semantics:

```json
{
  "journey_id": "00000000-0000-4000-8000-000000000042",
  "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  "tracestate": "vendor=value"
}
```

`traceparent` and `tracestate` use W3C Trace Context. HTTP upgrades use the
same headers plus `x-chalk-journey-id`; browser clients that cannot set upgrade
headers send the three fields on `hello`. The server forwards valid context on
its response frames and creates a journey at v1 sync ingress when one is absent.

## Verification

The shared [`reliability harness`](./docs/reliability-harness.md) maps pull
requests, nightly schedules, and release candidates to increasing profiles. It
covers PostgreSQL-backed semantics, Sync v1 and whiteboard transports,
multi-node partitions and process loss, PostgreSQL failover, sustained load,
Node restart recovery, and a real browser. Each run saves replayable,
commit-bound evidence and fails closed.

The external
[`release-topology-failure-schedule`](./docs/release-topology-failure-scheduler.md)
still controls staging provider drills. The replayable v1 matrix is documented
in [`sync-breaker-v1.md`](./docs/sync-breaker-v1.md); the complete acceptance
contract is covered by the checked-in Sync tests and reliability profiles.
