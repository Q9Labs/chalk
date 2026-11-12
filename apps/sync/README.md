# Chalk Sync Server

Elixir/OTP WebSocket sync server and the primary `SyncEngine` adapter.

Postgres is the sole durable authority for Episode control state, ordered events, command receipts, participant-episode lifecycle, lifecycle intents and external operation intents. Actual media publications remain MediaPlane truth. Every BEAM process, ETS table, notification and SDK replica is a disposable projection. Redis is not in the correctness path.

Commands: `mix deps.get`, `mix test`, `iex -S mix` (listens on `http://localhost:4100`), `scripts/gate.sh`. The root `pnpm dev` runs Sync with `MIX_ENV=prod` and `CHALK_SYNC_LOCAL_PARITY=true`: real Postgres, API-issued Ed25519 JWTs, and the generated local mTLS provider bridge, with identities created under `.private/chalk-dev/`. That is distinct from `CHALK_SYNC_LOCAL_PROOF`, which uses memory state.

## Durable command path

`WebSocket -> bounded admission -> node-local Episode coordinator -> semantic Postgres transaction -> folded state + exact-next event + stable receipt -> Postgres head notification -> bounded per-socket queue -> SDK replica`.

The authority key is `{tenant_id, episode_id}`, and the Episode control row is the serialization lock. One transaction returns a committed event and receipt or a stable rejected receipt. An uncertain COMMIT is resolved by reading the receipt from a fresh writable-primary connection. `Episodes.Reducer` is pure; `Stateholder.Postgres` is the only owner of `Postgrex.transaction/3`, and no collaborator opens its own transaction. The coordinator caches only local heads. Notifications speed delivery, and a periodic authoritative head read repairs dropped hints.

## Lifecycle

- Opening or losing a socket never directly creates a durable join or leave. Removal, explicit Leave, capability recovery, deadline expiry, Recording and Episode end reserve idempotent external operations under the Episode control lock. Explicit Leave commits departure, authority revocation, event, receipt, webhook outbox and a generation-scoped cleanup operation in one transaction; the departure time is Leave acceptance time, and exhausted cleanup is kept as a failed cleanup without changing attendance or the receipt.
- Each node runs local, provider and a one-at-a-time lane (see `ChalkSync.ExternalOperationConsumer`). Local operations only change Postgres, so a provider call never delays them. All lanes claim with `FOR UPDATE SKIP LOCKED` and finalize under the Episode control lock, so rows may run in any order.
- A socket renews one shared Postgres Episode lease on entry and each client ping (SDKs ping every 20 seconds). After 120 seconds with no renewal the empty-room linger starts, and after the customer's linger the ordinary Episode-end operation stops media and recording. Room-lease expiry never issues Leave or changes attendance. A return before end cancels the window.
- Each live connection also renews a participant-generation lease. After 120 seconds the API scheduler reserves an ordinary participant leave under the same Episode lock. A legacy joined participant that never opened a socket has no lease and gets a separate 600-second grace.
- Presence-based expiry pauses while no lease-aware Sync is connected to Postgres. Each startup or reconnect writes a session witness and a fresh 120-second recovery floor before serving, so a Sync or database outage never causes inferred abandonment.
- Rollout: apply the additive migration before API and Sync, and replace the whole Sync fleet before relying on abandonment cleanup, since older servers do not renew room leases. Rollback can leave the tables. Trade-off: if everyone is cut off from Sync for grace plus linger while the service is otherwise up, the Episode ends even if media still flows.
- The v1 transport checks heartbeats every 20 seconds and closes after five consecutive misses (80 to 100 seconds), so Chromium's once-per-minute timer wake-ups in silent background tabs survive. The WebSocket idle timeout is 120 seconds so it never races a throttled heartbeat. The cost is that a silent open socket takes 80 to 100 seconds to mark disconnected; explicit Leave and TCP close stay immediate.

## Protocol v1

The language-neutral source is `contract/schema/sync-v1.json`; generated Elixir and TypeScript bindings are checked by the root codegen gate. Frame bounds, command IDs, recovery rules and reservations are defined there and in the reducer. Two invariants worth knowing: control events keep their reservations until the SDK confirms the exact applied revision and digest (snapshots and replay pages until an exact `recovery_ack`), and MediaPlane observations carry monotonic incarnation/sequence cursors so a stale provider snapshot cannot overwrite newer truth.

**Follow views.** An Episode must be served by one Sync node (production runs one container). If Sync ever runs several nodes, route each Episode to one node: view messages deliberately do not use PostgreSQL fan-out. One on-demand node-local process owns an Episode's disposable view state, serializes moves across a person's tabs, and stops when its last socket leaves. Clients negotiate `view_v1` with `origins: true, owner: true`, the welcome names the owner's start UUID with an atomic snapshot, and every reconnect discards cached views and sequences. An owner crash closes sockets with 1012 to force the same handshake. Real moves carry `move: true` and an `input_id` of `tab-UUID:sequence`; a per-tab high watermark prevents duplicates, and heartbeats use `move: false` so they cannot reclaim another tab's geometry. The owner admits at most 500 active people and 1,024 input streams and stops admitting rather than evicting deduplication watermarks. SDK 5.0 and 5.1 messages stay accepted; owner fields never go to clients that did not negotiate them.

**Opt-in extensions.** New web SDKs opt in by WebSocket query, and none of these fields change the canonical control digest. Sockets without the query keep the earlier shape, and new SDKs accept older servers that omit the fields.

- `participant_devices=1`: presence items may carry `identity_id` (from the admitted participant's tenant-scoped row) and a best-effort `device_type`.
- `connection_quality=1`: the SDK sends `connection_quality_set` (`good`, `weak`, `poor`) when its tier changes. Sync keeps it in memory per socket and projects the worse tier when a seat has two sockets. The frame from a socket that did not opt in is a `protocol_error`. Nothing is stored.
- `media_off_reason=1`: a disabled media item may carry `off_reason` (`host`, `self`, or `dead`, which only a deliberate tombstone uses). A missing reason means no evidence, never "off". A host stop (`off_reason: host` plus `off_revision`) is stored in `sync_media_stops` in the same transaction as its event, until a newer host stop for the same participant and source replaces it. An accepted on does not clear it. A device compares its own intent's control revision with `off_revision`: a newer intent wins, an older one stays off. The welcome carries `"media_off_reason": true`, and the SDK applies the `off_reason` rule only on such a connection. Finish the Sync rollout on every instance before releasing the SDK, because an old instance can commit a host stop without filling the table while a new one advertises the extension.

**Migrations that must run before Sync.** `20261031120000_sync_media_stops`: every live registration reads the table, so without it readiness fails with `incompatible_database_migration`. `20261106120000_sync_source_control_revisions`: source grants and stops record `control_revision` from a sequence taken under the Episode row lock, which the provider bridge sends so the own SFU orders grants and revokes per source. The control stream revision cannot serve here because it counts committed events. This is the `minimum_compatible_sync_migration` floor. A rollback leaves the columns; the previous Sync writes null, and the API never renews a grant without a revision, so its own-SFU grants lapse.

The provider bridge observer requests `media-observations?latest=true` for one current snapshot instead of the full history. Deploy API support for it before updating Sync.

## Operations

- `/healthz` proves the listener is alive; `/readyz` applies dependency checks with hysteresis; `/metrics` exposes fixed-cardinality counters.
- SIGTERM drains boundedly, rejects new work, resolves accepted decisions and closes clients with retryable 1012.
- Ended Episode history is folded and checkpointed before the retention worker deletes eligible rows after seven days.
- Production boot refuses Memory, the development verifier, an incompatible migration, a non-writable database and a missing required synchronous standby. `CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY` defaults to `true`; set `false` only for an approved single-node deployment without failover (readiness reports `not_required`; all other database checks stay on).
- Admission verifies API-issued Ed25519 JWTs locally with `CHALK_SYNC_TOKEN_ISSUER`, `CHALK_SYNC_TOKEN_AUDIENCE` and `CHALK_SYNC_TOKEN_PUBLIC_KEYS` (a JSON object of `kid` to unpadded base64url 32-byte public key). On rotation, render both public keys before the API signs with the new `kid`.
- Durable media operations use the API's private provider bridge over mutual TLS 1.3: `CHALK_SYNC_PROVIDER_BRIDGE_URL`, `_CERTFILE`, `_KEYFILE` (unencrypted) and `_CAFILE`. Startup fails on any missing or malformed value, and readiness probes the endpoint. The seven-second bridge request budget stays below the eight-second durable-operation consumer budget.

**Direct connections.** A host TLS proxy can accept `/v1/sync` upgrades without the Tunnel (see [the operator runbook](../../docs/operators/direct-sync-path.md)). It overwrites `Cf-Connecting-Ip` with the TCP peer and sets `X-Chalk-Ingress: direct`. Sync trusts the marker only to pick stricter bounds, so a client that sets it on the Tunnel limits only itself. `ChalkSync.Transport.DirectLimits` keeps per-IP and per-tenant bounds as disposable node-local state (defaults and `CHALK_SYNC_DIRECT_*` overrides are in that module), fails closed with 503 when it cannot answer, and forgets all counts on restart. The listener closes any message over 256 KiB with 1009, for Tunnel sockets too. Decisions appear as `chalk.sync.direct.admission.<outcome>.<stage>` metrics and the `ingress` attribute on `sync.websocket.handshake`.

## Observability

`ChalkSync.Observability` emits `[:chalk_sync, :observability, :event]` telemetry, correlated Logger metadata and short OpenTelemetry spans, never a connection-long span. Set `CHALK_SYNC_OTLP_ENDPOINT` to export OTLP HTTP/protobuf (service name `chalk-sync`); otherwise the exporter is off. Tokens, Space IDs, participant IDs, command IDs and raw revisions are never observability dimensions.

Frames may carry optional top-level `journey_id`, `traceparent` and `tracestate` (W3C Trace Context), which HTTP upgrades carry as headers (plus `x-chalk-journey-id`). Browsers that cannot set upgrade headers send them on `hello`. The server creates a journey at ingress when none is supplied.

A session is one run of a Chalk app on one device, not an Episode. Its ID arrives as `baggage: session.id=<lowercase UUID>` on `hello` or the upgrade header (header first). Anything else in baggage is ignored, and a malformed value never rejects a connection. The session is connection-scoped and never goes on server frames or into journey, lifecycle or external-operation records.

## Verification

```sh
box run -- 'bash scripts/gates/instabox-run.sh --browser scripts/gates/with-postgres.sh apps/sync/scripts/reliability-correctness'
```

The external [`release-topology-failure-schedule`](./docs/release-topology-failure-scheduler.md) controls nightly provider drills.
