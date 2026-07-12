# Chalk Sync Engine Production Overhaul Specification

<!-- cspell:words backpressure bytea coalescible discoverably erpc goldens idempotently libcluster PITR Postgrex replayable transactionally unclustered unpartitioned -->

**Status:** Implemented locally; production acceptance blocked
**Date:** 2026-07-12
**Applies to:** `apps/sync`, the sync contract, the TypeScript client runtime,
the API lifecycle boundary, database migrations, and the sync stress harness
**Evidence report:**
[`sync-production-readiness-report-2026-07-12.md`](sync-production-readiness-report-2026-07-12.md)

## Decision

Chalk will overhaul the current sync engine in place and preserve the parts
that already express useful boundaries. The production design has one durable
authority: Postgres.

Postgres owns durable Session control state, the ordered event log, command
receipts, participant-session lifecycle facts, and lifecycle delivery intents.
An acknowledged outcome is recoverable from Postgres after every supported
process, node, or database failover.

BEAM processes own disposable working copies, local subscriptions, connection
state, and bounded queues. Postgres row locking establishes the order of
concurrent commands. The design omits cluster-wide BEAM writer leases,
application fencing epochs, `libcluster` command routing, and `:erpc` command
paths.

Postgres `LISTEN/NOTIFY` is the default committed-head hint. Periodic
authoritative head comparison repairs every missed hint. Redis may later carry
the same hints, volatile presence, or rebuildable caches. Durable control stays
correct and ready with Redis completely absent.

The server implements a strict sync protocol v2 and a production TypeScript
client runtime. The existing v1 schema remains frozen as historical contract
evidence. Production clients and servers move to v2 together before launch.

Server-side SQLite is outside the launch design. SQLite remains appropriate for
device-local pending-command persistence and may become a separately specified
single-node development adapter. Postgres remains the shared production
authority.

## Answer about the Elixir layout

Yes. Application modules conventionally live under `lib/` in a Mix project.
Tests live under `test/`, configuration under `config/`, and runtime assets such
as SQL under `priv/`. Chalk already follows that convention.

The `lib/` placement is correct. The overhaul repairs responsibility boundaries
inside it by separating the pure reducer, durable decisions, node-local
coordination, recovery, fanout, presence, and transport.

## Current-state verdict

The durable core is locally robust. The production release is not ready.

The implementation now has a Session-scoped Postgres authority, atomic control
decisions and lifecycle intents, durable receipts, an exact-next reducer,
protocol v2, bounded paged recovery and live delivery, a production TypeScript
runtime, dependency-aware operations, retention, and deterministic failure
artifacts. Redis is absent from the correctness path. Two independent local
BEAM nodes, real Chromium, a restarted Node client, slow TCP peers, and a real
local PostgreSQL 18.3 primary have exercised the principal paths.

The six deterministic failures that motivated the overhaul are corrected:

1. committed and rejected outcomes survive process and connection-set restart;
2. durable receipts preserve old command outcomes beyond the former 256-entry
   cache;
3. uncertain commits resolve through the receipt on the writable primary;
4. revision conflicts do not leave an authoritative empty writer;
5. live and recovery frames remain reserved inside bounded queues until the
   client confirms the exact applied revision and digest;
6. supplied events must be exactly next in the reducer and database.

Production acceptance remains blocked by four missing proofs or integrations:

- no production token issuer/verifier adapter is wired into the release;
- the available database has no synchronous standby, promotion, or isolated
  point-in-time restore surface;
- the launch envelope is unapproved, so the required 60-minute load and
  eight-hour soak have no authoritative rates and have not run;
- the v2 migration deliberately refuses populated legacy Session data, and no
  approved backfill or verified-empty production target exists.

The evidence report records every local pass, the saved failed campaign, and
the exact production blockers. No local test substitutes for the missing
database topology, deployment integration, or launch envelope.

## Product boundary

### In scope

- durable `session.control` state and events;
- command idempotency and stable terminal decisions;
- snapshot, replay, live catch-up, and replica convergence;
- Session and participant-session lifecycle integration with the API;
- multi-node sync service operation through one Postgres authority;
- bounded WebSocket delivery and overload behavior;
- the TypeScript core client plus browser and React Native persistence seams;
- dependency-aware boot, readiness, drain, telemetry, and release artifacts;
- deterministic, real-wire, real-Postgres, failover, load, and soak evidence.

### Outside this specification

- media-plane synchronization provided by Cloudflare RealtimeKit;
- cursor, typing, speaking, and other volatile streams beyond their separation
  from durable control;
- general-purpose document CRDTs;
- a server-side SQLite production topology;
- a required Redis deployment;
- penetration testing, offensive security testing, and cryptographic redesign;
- deployment to production without explicit approval in the active thread.

Token signature verification and capability enforcement remain functional
correctness requirements. Cybersecurity testing remains outside this work.

## Canonical language and identity

### Room

A Room is the durable product container. It can have many distinct
occurrences.

### Session

A Session is one occurrence of a Room. Every durable sync revision, event,
receipt, lifecycle intent, snapshot, and retention window belongs to one
Session.

### Participant session

A participant session is one admitted participation occurrence inside a
Session. The current `participants` row represents this concept and is evolved
with explicit `status` and `generation` columns. `participants.id` is the
`participant_session_id`; `users.id`, when present, remains the user identity.

Reconnects reuse the same participant-session ID and generation. Explicit
removal or replacement invalidates the old generation. Multiple sockets may
belong to one active participant session without creating extra durable joins.

### Session key

The authority and revision key is `{tenant_id, session_id}`. `room_id` supplies
verified context. Every query also verifies that the Session belongs to the
claimed tenant and Room.

### Command key

The command key is:

```text
{tenant_id, session_id, participant_session_id, command_id}
```

The client creates one opaque command ID and reuses it unchanged for every
retry. V2 accepts 16–64 ASCII characters matching `[A-Za-z0-9_-]+`. UUIDs and
ULIDs are suitable; the server does not derive expiry from a client clock.

The server stores a fingerprint of the normalized command name and payload.
Reuse of one key with different intent returns `command_id_conflict` and never
changes the original decision. The receipt stores the generation submitted with
the first decision. The idempotency key deliberately excludes generation, so a
retry after token rotation resolves the original receipt before current
generation validation. A genuinely new participation has a new
participant-session ID and a separate command namespace.

### Lifecycle intent key

Every durable join, explicit removal, or Session end has an API-generated
`lifecycle_intent_id`. Delivery attempts reuse that ID. At most one control
event may originate from it.

## Authority model

```text
API product rows + lifecycle intents
                 │
                 ▼
Postgres folded control row + event log + command receipts
                 │
                 ├── transactional NOTIFY head hint
                 ├── optional Redis head hint
                 ▼
disposable node-local Session coordinators
                 │
                 ▼
bounded socket queues → SDK canonical replicas + pending overlays
```

The source-of-truth map is exact:

| Fact                          | Durable authority                     | Disposable copies                      |
| ----------------------------- | ------------------------------------- | -------------------------------------- |
| Room and Session lifecycle    | API Postgres tables                   | API and sync caches                    |
| Participant-session lifecycle | `participants` plus lifecycle intents | token claims, local presence           |
| Durable control state         | `sync_session_control`                | coordinator and SDK replicas           |
| Ordered control history       | `sync_control_events`                 | recovery pages and local caches        |
| Command outcomes              | `sync_command_receipts`               | process hot cache and SDK pending map  |
| Connection presence           | no historical authority               | local ETS; optional Redis TTL state    |
| Client retry queue            | client persistence adapter            | in-memory pending overlay              |
| Fanout notification           | no authority                          | Postgres notifications; optional Redis |

Deleting Redis, every sync node, and every SDK replica must leave every
acknowledged durable outcome recoverable from Postgres.

## Target Elixir structure

The implementation evolves the existing code in place:

```text
apps/sync/lib/chalk_sync/
  sessions/reducer.ex              pure command/event/state rules
  sessions/coordinator.ex          node-local cache and subscriptions only
  sessions/command_admission.ex    bounded node and Session admission
  stateholder.ex                    semantic durable-decision contract
  stateholder/postgres.ex           production Postgrex transactions
  stateholder/memory.ex             deterministic test adapter only
  fanout.ex                         committed-head hint port
  fanout/postgres_notifications.ex  default LISTEN/NOTIFY adapter
  fanout/redis.ex                   optional optimization, added only if needed
  presence.ex                       explicitly volatile presence port
  presence/local.ex                 local TTL implementation
  transport/socket.ex               protocol and connection state
  transport/recovery.ex             snapshot/replay/live catch-up
  transport/outbound_queue.ex       bounded per-socket delivery
  protocol.ex                       generated-v2 boundary and error mapping
```

`ChalkSync.Rooms.Room` becomes `ChalkSync.Sessions.Reducer` because it models a
Session occurrence. `RoomServer` becomes a node-local `SessionCoordinator`; it
does not own command order or a cluster-wide identity. The rename is performed
once with compiler-checked call-site changes. No compatibility wrapper remains.

The Stateholder boundary exposes semantic decisions and reads. Its API prevents
callers from assembling only part of a transaction through generic
compare-and-set operations. Production behavior names Postgres explicitly.
Memory exists solely for deterministic conformance and model tests.

## Release-blocking invariants

### C1. Correct isolation

Different tenants and different Sessions of one Room have independent state,
revision chains, receipts, lifecycle intents, and retention. A token cannot
select another authority key through frame data.

### C2. Postgres is the durable authority

No process heap, ETS table, Registry entry, notification, Redis key, or client
replica is needed to recover a terminal command decision or durable control
state.

### C3. One atomic command decision

One Postgres transaction produces exactly one of these outcomes:

- a committed event, folded-state update, revision increment, and committed
  receipt; or
- a terminal rejected receipt with no event and no state revision change.

Partial durable outcomes are impossible.

`command_id_conflict` is a derived response when the authoritative receipt key
already exists with another fingerprint. It returns from that original receipt
and does not create a contradictory second receipt.

### C4. Stable idempotency

Within the supported retention period, one command key has one stable terminal
decision. Retrying the same intent returns that decision. A committed retry is
reported as `duplicate`; `duplicate` is derived from the committed receipt and
is not a third stored outcome.

### C5. Honest uncertainty

The server sends `committed`, `duplicate`, or terminal `rejected` only after it
has read the corresponding committed receipt from the writable Postgres
authority. A timeout or connection loss around `COMMIT` triggers receipt lookup
on a fresh primary connection. If resolution remains unavailable, the command
stays pending and receives a retryable error. Infrastructure uncertainty is
never encoded as terminal rejection.

For `command_id_conflict`, the corresponding authority is the original receipt
whose stored fingerprint proves the mismatch.

### C6. Exact event chain

While history is inside its declared retention window, for event `n`,
`revision = base_revision + 1`, and its base revision equals the previous
durable head. A Session has at most one event at each revision. The folded state
at revision `n` equals an independent fold of events through `n`. The reducer
returns an error for a gap, duplicate, unknown event, invalid payload, or
invalid state transition; it never crashes on decoded input.

Each stored revision also has a deterministic state digest. The server and SDK
recompute it from the schema-defined canonical control projection. A digest
mismatch at the same numeric revision is corruption and forces snapshot
replacement; revision equality alone never proves convergence.

### C7. Durable lifecycle is transport-independent

Socket attachment and loss update volatile presence only. Durable join,
participant removal, and Session end originate from idempotent lifecycle
intents. Losing the last socket never emits `participant_left`.

### C8. Gap-free recovery

Every accepted hello produces one bounded active recovery result—`snapshot`,
`replay`, or `up_to_date`—or a terminal lifecycle result at an explicit
Postgres head. Events committed after an active recovery head are then delivered
as an exact suffix. Missed notifications are repaired by authoritative head
reads. `up_to_date` requires both revision and state digest to match.

### C9. Client convergence

After faults stop and dependencies recover, every connected SDK canonical
replica reaches the Postgres head. ACK/event reordering, duplicate frames,
reconnects, snapshot replacement, and retained optimistic commands do not
change the final canonical state.

### C10. Hints are disposable

Dropping, duplicating, delaying, reordering, or disabling all fanout hints may
increase recovery latency. It cannot lose an event, invent a revision, change a
receipt, or block durable command decisions.

### C11. Every queue and retained set is bounded

Inbound frames, command work, Postgres waits, replay pages, snapshots, outbound
delivery, client pending commands, diagnostic traces, events, receipts, and
lifecycle intents have named limits and explicit overflow behavior. Slow
subscribers are disconnected into normal recovery without slowing other
subscribers or command commits.

### C12. Acknowledged durability matches the database topology

At launch, an acknowledged terminal decision survives loss of one sync node,
all sync nodes, the Postgres primary process, and a promoted synchronous
standby. The release report states the exact database settings and demonstrated
recovery point. Chalk makes no stronger durability claim than the tested
topology provides.

## Postgres data model

All schema changes use the repository's operational migration ledger under
`apps/api/db/migrations/`. `apps/api/db/schema.sql` is updated as the checked-in
schema snapshot. The API does not run hidden startup migrations. The sync
release refuses readiness when the required migration version is absent.

The API and sync server connect to the same Postgres authority. The sync server
uses `Postgrex` directly for its transaction path; it does not call the Go API
for each command.

### Existing product tables

`room_sessions` remains the canonical Session row. It gains a database
constraint that allows tenant, Room, and Session consistency to be referenced
as one key.

The existing `participants` table is the participant-session table for this
release. It gains:

```text
generation bigint not null
status text not null       -- joining | active | leaving | left
joined_at timestamptz
left_at timestamptz
```

Allowed statuses and transitions are enforced by database checks and API
logic. The token carries the row ID and generation. Explicit removal ends that
row, and a later admission creates a new row at generation one. Administrative
token invalidation for an otherwise continuing participation increments the
existing row's generation. API, token, receipt, and event keys apply this rule
consistently.

The durable v2 participant projection contains only
`participant_session_id`, a display name of at most 256 UTF-8 bytes, and the
generated control flags such as `hand_raised`. Product metadata and capability
arrays remain outside the folded sync snapshot. API admission validates these
limits before inserting an intent or issuing a token. Cross-language maximum
encoding fixtures, including worst-case JSON escaping, must prove that one
canonical participant entry fits the 2 KiB reservation.

### `sync_session_control`

One row exists per `{tenant_id, session_id}`:

```text
tenant_id uuid
room_id uuid
session_id uuid
control_revision bigint not null default 0
folded_state jsonb not null
state_schema_version integer not null
state_digest bytea not null
snapshot_bytes bigint not null
snapshot_reserved_bytes bigint not null default 0
participant_event_count bigint not null default 0
participant_event_bytes bigint not null default 0
lifecycle_event_count bigint not null default 0
lifecycle_event_bytes bigint not null default 0
lifecycle_reserved_events bigint not null default 1
lifecycle_reserved_bytes bigint not null default 16384
lifecycle_intent_count bigint not null default 0
lifecycle_intent_bytes bigint not null default 0
lifecycle_reserved_intents bigint not null default 1
lifecycle_reserved_intent_bytes bigint not null default 16384
receipt_count bigint not null default 0
receipt_bytes bigint not null default 0
created_at timestamptz not null
updated_at timestamptz not null
primary key (tenant_id, session_id)
```

The row is the command serialization lock. Revisions are calculated from this
row; a Postgres sequence is forbidden because rollback would create gaps.
Tenant, Room, and Session consistency is enforced by a composite foreign key.
`snapshot_bytes` is the exact encoded v2 snapshot size;
`snapshot_reserved_bytes` protects admitted but unapplied state growth.

`state_digest` is SHA-256 over the ASCII prefix
`chalk-sync-state-v2`, a zero byte, the big-endian state-schema version, and the
RFC 8785 encoding of the generated durable control-state projection. The
projection excludes presence, connection IDs, timestamps, and other volatile
fields and sorts schema-defined collections by their stable IDs. Elixir and
TypeScript share golden digest vectors, including Unicode and empty-state
cases. The digest detects replica corruption and carries no security or
tamper-evidence guarantee.

### `sync_control_events`

The append-only event table contains:

```text
tenant_id uuid
room_id uuid
session_id uuid
event_id uuid
base_revision bigint
revision bigint
event_name text
payload jsonb
actor_participant_session_id uuid null
actor_generation bigint null
command_id text null
lifecycle_intent_id uuid null
event_schema_version integer
resulting_state_digest bytea
encoded_bytes integer
created_at timestamptz
```

Required constraints are:

- primary or unique key on `{tenant_id, session_id, revision}`;
- unique `event_id`;
- unique non-null `{tenant_id, session_id, lifecycle_intent_id}`;
- unique non-null
  `{tenant_id, session_id, actor_participant_session_id, command_id}`;
- `revision = base_revision + 1`;
- exactly one origin: command ID or lifecycle intent ID;
- a command origin requires actor participant-session ID and generation;
- a 32-byte resulting digest and positive encoded size within the event limit;
- bounded event name and payload size at the application boundary;
- composite Session and participant-session consistency.

### `sync_command_receipts`

The terminal receipt table contains:

```text
tenant_id uuid
session_id uuid
participant_session_id uuid
submitted_generation bigint
command_id text
request_fingerprint bytea
command_name text
outcome text                  -- committed | rejected
rejection_reason text null
event_id uuid null
resulting_revision bigint null
created_at timestamptz
```

The composite command key without generation is the primary key. Constraints
require an event ID and revision only for `committed`, and a reason only for
`rejected`. Rejection reasons use an exhaustive protocol enum. A composite
foreign key for committed receipts references the
exact command-origin event, including tenant, Session, participant-session,
submitted/actor generation, command ID, event ID, and revision. Generation
remains excluded from the command-origin uniqueness key.

Receipts remain available for the whole active Session and seven days after it
ends. This is longer than the SDK's maximum 24-hour pending-command lifetime.
Cleanup never removes a receipt from an active Session.

### `sync_lifecycle_intents`

This table is both the API-to-sync delivery ledger and the idempotency boundary
for durable lifecycle work:

```text
tenant_id uuid
room_id uuid
session_id uuid
lifecycle_intent_id uuid
request_key text
request_fingerprint bytea
intent_name text              -- participant_joined | participant_left | session_ended
participant_session_id uuid null
participant_session_generation bigint null
payload jsonb
status text                   -- pending | applied | superseded
terminal_reason text null
applied_event_id uuid null
applied_revision bigint null
attempt_count integer
last_error_code text null
created_at timestamptz
completed_at timestamptz null
```

The intent ID is the primary key.
`{tenant_id, session_id, intent_name, request_key}` is unique and lets an API
retry return the original product transition and intent. The request
fingerprint covers tenant, Room, Session, target participant and generation,
intent name, and normalized payload. Reuse with another fingerprint returns an
API idempotency conflict. Session end is additionally unique per Session, and
join or leave is unique per target participant-session transition. Request keys
contain 16–128 ASCII characters, and normalized intent payloads are at most
16 KiB. Product-row mutation and intent insertion occur in the same API
transaction. Sync workers
discover pending IDs in bounded pages and apply each ID through the same locked
Session control row used by commands. Concurrent workers may attempt one ID;
the unique origin constraint and locked intent status make the operation
idempotent. A crash leaves the intent pending or discoverably applied; it never
creates two events.

Discovery returns IDs from a completed read transaction and holds no row lock.
The application transaction then locks the Session control row first, the
specific intent second, and rechecks `pending` before touching product rows.
`FOR UPDATE SKIP LOCKED` discovery is forbidden when its lock would be retained
into application.

`applied` requires an event ID and revision and has no terminal reason.
`superseded` requires one of `superseded_by_session_end`,
`participant_already_terminal`, or `participant_generation_replaced` and
forbids event fields. When
Session end wins before a join or removal is applied, that pending intent is
atomically superseded, its product row is normalized to the ended state, and
its unused event and snapshot reservations are released. The single
`session_ended` event represents the terminal folded state.

Completed intents remain for seven days after Session end. Pending intents are
bounded by the Session counters, never expire silently, and raise an alert
after the configured delivery deadline. A permanently invalid internal intent
remains visible and blocks lifecycle readiness until repaired; it is not
discarded or converted into a fabricated event.

### Indexes and partitioning

Indexes cover Session revision reads, command-key lookup, pending lifecycle
work, and ended-Session cleanup. The launch tables remain unpartitioned so their
global uniqueness constraints stay direct. A later partitioning migration
requires measured need and separate proof that command, event, and revision
uniqueness remain enforceable.

Every query used by recovery and decision paths has an `EXPLAIN (ANALYZE,
BUFFERS)` fixture at launch-scale cardinality. Sequential scans on retained
event or receipt tables block release.

### Migration-level constraints

The migration encodes the invariants directly:

- `room_sessions` has unique `{tenant_id, room_id, id}` and a checked lifecycle
  enum including `active`, `ending`, and `ended`;
- `participants` has its existing primary key, positive generation, checked
  status, and unique `{tenant_id, room_id, session_id, id}`;
- the control table has its declared primary key, composite Session foreign key,
  nonnegative revision and counters, 32-byte state digest, snapshot bound, and
  lifecycle used-plus-reserved checks;
- the event table has its Session-revision primary key, unique event ID,
  positive exact-next revision check, origin-variant check, partial unique
  command and lifecycle origin indexes, and composite Session and participant
  foreign keys;
- a unique event tuple supports the committed-receipt composite foreign key on
  `{tenant_id, session_id, actor_participant_session_id, actor_generation,
command_id, event_id, revision}`, with `submitted_generation` mapped to
  `actor_generation`;
- receipts have the command-key primary key, positive submitted generation,
  bounded command/fingerprint fields, and committed/rejected variant checks;
- lifecycle intents have their intent-ID primary key, request and transition
  uniqueness, a fixed-length request fingerprint, bounded payload, checked
  status/reason variants, and a composite applied-event foreign key;
- authoritative parents use `ON DELETE RESTRICT` while retained sync rows exist;
  explicit post-retention product deletion orders child cleanup before parent
  deletion.

Status transitions in both Go and Elixir use conditional updates such as
`UPDATE ... WHERE status = $expected AND generation = $expected_generation` and
assert exactly one affected row. Database checks validate states; conditional
updates and concurrency tests validate transitions.

## Atomic command workflow

The public Stateholder operation is one semantic `decide_command` call. The
Postgres adapter performs this sequence on the writable primary:

1. Acquire bounded command-admission capacity before checking out a connection.
2. Begin a transaction with explicit checkout, lock, statement, and total
   deadlines.
3. Lock `sync_session_control` for the Session with `SELECT ... FOR UPDATE`.
4. Lock the matching `room_sessions` and `participants` rows and verify their
   tenant/Room relationship; defer mutable lifecycle validation until after
   receipt resolution.
5. Look up the command receipt before evaluating current lifecycle or control
   state.
6. If a receipt exists with the same fingerprint, return the stored decision.
7. If the key exists with a different fingerprint, derive
   `command_id_conflict` from the original receipt without mutation.
8. Verify Session status, participant status and generation, capabilities,
   command schema, and business preconditions from the locked Postgres facts.
9. For a terminal business rejection, insert the rejected receipt, update the
   receipt capacity counters, and commit without an event or revision change.
10. For an accepted command, calculate exactly
    `next_revision = control_revision + 1`.
11. Run the pure reducer against the locked folded state, compute the canonical
    snapshot size, state digest, and exact encoded event bytes, and construct
    the exact next event. Reject ordinary state growth that would exceed the
    snapshot or event bound.
12. Insert the event, update the folded state, revision, and capacity counters,
    and insert the committed receipt in the same transaction.
13. Call transactional `pg_notify` with only the Session key and new head.
14. Commit.
15. Update disposable local state and respond only from the committed returned
    receipt and event.

The fixed lock order is Session control row, existing lifecycle intent row when
present, product Session row, then participant-session row. Commands omit the
intent lock. API join, removal, and end transactions acquire the same Session
control row before mutating product rows or inserting intents, so lifecycle
capacity and command/end order share one serialization point. They never wait
on a sync network call. Session creation inserts its new product and control
rows together because no prior control row exists.

A command already inside its transaction either commits before a concurrent
Session-end product update or observes `ending`/`ended` and receives the stable
`session_ended` rejection. Network calls never occur while database locks are
held.

If the adapter loses the connection before it can observe `COMMIT`, it opens a
fresh primary connection and resolves the exact command receipt. A present
receipt is authoritative. If no receipt exists, retrying the same transaction
is safe. If the primary cannot be reached, the server returns retryable
`decision_unavailable` and the SDK keeps the command pending.

## Lifecycle workflows

### Session creation

The API transaction creates `room_sessions` and its revision-zero
`sync_session_control` row together. The initial folded state is schema-valid
and empty. It reserves one lifecycle event and one lifecycle intent, each with
a 16 KiB byte charge, for eventual Session end. A retry uses the API request's
existing idempotency boundary.

### Participant join

The API locks the Session control row and active product Session, checks
lifecycle, intent, participant, and snapshot capacity, reserves one join event,
one future removal event and intent, and the maximum participant snapshot
entry. The same transaction consumes one current intent slot to create the
`joining` participant-session row and `participant_joined` intent. It issues a
token containing that exact intent ID only after the transaction commits. A
background sync consumer applies the intent. If the socket arrives first, hello
applies the token's intent before computing recovery. The application
transaction consumes the join event reservation, appends one join event,
advances folded state and exact snapshot bytes, releases the snapshot
reservation, leaves the removal event and intent reservations protected, marks
the participant `active`, and marks the intent `applied` atomically. Retrying
the API request with the same request key returns the same participant-session
row and lifecycle intent.

### Reconnect and multiple sockets

Reconnect uses the same participant-session ID and generation. Attaching a
second socket changes only volatile presence. Welcome recovery reconstructs
durable control; no extra join event is emitted.

### Explicit participant removal

The API transaction locks the Session control, product Session, and active
participant rows, verifies its protected removal reservation, changes the
participant status to `leaving`, converts the protected removal-intent reserve
into the inserted `participant_left` intent, and leaves the event reserve in
place.
That status immediately stops new commands from the old token. The sync
application transaction consumes the removal reservation, appends the event,
removes the participant from folded state, changes status to `left`, and marks
the intent applied. A token for that ended participant session receives a
terminal lifecycle rejection. Retrying the removal request with the same
request key returns the original transition and intent.

### Session end

The API end transaction locks the Session control and product Session, consumes
no new capacity because Session creation already protected the end event and
intent, converts the intent reserve into the inserted `session_ended` intent,
and changes the Session from `active` to `ending`. New joins and commands stop
immediately. The sync
application transaction consumes the end reservation, supersedes every other
pending lifecycle intent, releases their unused join, removal, and snapshot
reservations, marks every participant row `left`, appends the terminal event,
folds terminal control state, marks the end intent applied, and changes the
product Session to `ended` with `ended_at`. Repeated end requests resolve the
same lifecycle intent. After the terminal event is delivered, the server drains
its bounded queue and closes the socket; the SDK enters `ended` and does not
reconnect. Cleanup begins only after end is durably applied.

### Socket loss

Socket loss removes a volatile connection record after its TTL. It emits no
durable event and changes no product or participant-session row.

## Protocol v2

`contract/schema/sync-v2.json` is the language-neutral source. Code generation
is parameterized by protocol version and continues to reproduce v1 Elixir and
TypeScript outputs byte-for-byte. Generated-code drift fails CI.

The production WebSocket route is `/v2/sync`. `/v1/sync` remains available only
for explicit compatibility tests during the migration and is disabled in the
production launch configuration. HTTP route and frame protocol versions are
both explicit and independently validated.

### Identity

The verified token supplies:

```text
tenant_id
room_id
session_id
participant_session_id
participant_session_generation
admission_lifecycle_intent_id
capabilities
issued_at
expires_at
```

Frame fields cannot override this identity. The server rechecks Session and
participant-session lifecycle inside every decision transaction. The admission
intent must be the unique `participant_joined` intent for the claimed tenant,
Session, participant-session ID, and generation.

### Connection states

The server socket state machine is:

```text
awaiting_hello -> recovering -> live -> draining/closed
                           \-> terminal -> closed
```

Hello must arrive within five seconds. Only hello and ping are accepted before
recovery. Commands are accepted only in `live`. The connection has a 20-second
heartbeat interval and closes after two missed heartbeat deadlines.

### Recovery frames

Hello carries protocol version, token, requested streams, and the last applied
control cursor or `null`. A control cursor is
`{revision, state_schema_version, state_digest}`. Welcome declares:

- participant-session ID and generation;
- authoritative control head with revision, schema version, and state digest;
- recovery mode: `snapshot`, `replay`, `up_to_date`, or `terminal`;
- a recovery ID and schema version.

Snapshot mode carries one bounded folded state. Replay mode is followed by
ordered `replay_page` frames. Each page declares its exact first and last
revision. `recovery_complete` declares the recovered head. Live events begin
only after completion.

A null, future, malformed, expired, unavailable, or same-revision digest-mismatch
cursor receives a snapshot. For an older cursor, the server compares its digest
with the stored resulting digest at that revision before replay. A valid cursor
receives replay only when the suffix contains at most 2,048 events and 2 MiB of
stored encoded event bytes; otherwise it receives a snapshot.

A cryptographically valid hello for an ended Session, inactive participant, or
stale generation receives `terminal` with reason `session_ended`,
`participant_inactive`, or `stale_participant_generation`, plus the authoritative
terminal revision, schema version, and digest. The server then closes normally
after the frame drains. The SDK enters `ended` for `session_ended`; the other
reasons enter a stopped, rejoin-required state. None of these outcomes starts a
reconnect loop. An expired or invalid signature remains an authentication
failure.

### Commands and results

Every command contains `type`, `command_id`, a generated command-name enum, and
a strictly generated payload. Unknown fields and unknown commands are rejected.

Terminal ACKs are:

```text
committed  -- command_id, event_id, revision
duplicate  -- command_id, original event_id, original revision
rejected   -- command_id, exhaustive rejection reason
```

Retryable command errors carry the command ID and one of
`overloaded`, `server_draining`, `dependency_unavailable`, or
`decision_unavailable`. They are not receipts and tell the SDK to retain the
same pending command.

The initial terminal rejection enum includes `session_ended`,
`participant_inactive`, `stale_participant_generation`, `capability_denied`,
`invalid_state`, and `command_id_conflict`. Schema-invalid frames are protocol
errors and never enter the decision transaction.

### Events

Every event contains:

```text
event_id
stream
name
base_revision
revision
schema_version
resulting_state_digest
payload
command_id or lifecycle_intent_id
```

The origin fields are mutually exclusive. Clients accept ACK and event in
either order and reconcile them by command ID and event ID. After applying a
live event and verifying its resulting digest, the SDK sends a cumulative
`delivery_ack` containing the control stream, revision, and state digest.
After successfully installing a snapshot or fully reducing and verifying a
replay page, the SDK sends an exact `recovery_ack` containing the recovery ID,
applied revision, and state digest. Recovery frames do not produce live
delivery acknowledgments.

### Limits and close behavior

- decoded inbound frame: 64 KiB;
- token: 8 KiB;
- command ID: 16–64 bytes;
- decoded command payload: 16 KiB;
- encoded live event: 32 KiB;
- replay page: at most 128 events and 256 KiB encoded;
- complete replay: at most 2,048 events and 2 MiB encoded;
- snapshot: at most 1 MiB encoded;
- protocol error detail: 1 KiB and no reflected payload;
- retryable service restart or drain: WebSocket 1012;
- invalid token or policy violation: WebSocket 1008;
- malformed or oversized frame: WebSocket 1009 or a bounded protocol error,
  followed by close when the connection cannot safely continue.

Limits are enforced before copying decoded data into long-lived state.

### Schema and rolling compatibility

Every stored aggregate and event carries a schema version. A release must read
all versions still inside retention. A new write version is enabled only after
all serving nodes and the released SDK can read it. Database changes follow
expand, backfill, validate, enable, and later contract steps. Rollback remains
permitted until the enable step; after new-version writes begin, rollback is
allowed only to an artifact that declares support for that version.

The first production v2 launch may use a drain-and-replace deployment because
there is no production v1 client contract to preserve. Subsequent releases must
pass mixed-version read and rolling-drain tests. Protocol negotiation never
silently downgrades a v2 client into v1 semantics.

## Recovery, fanout, and local coordination

Each node owns one dedicated Postgres notification connection and node-local
coordinators only for Sessions with local sockets. A notification contains a
coalescible Session head, never event payload or authority state.

Each socket has a coordinator-owned recovery barrier with `mode`,
`enqueued_revision`, and `target_head`. All queue writes and live transitions
for that socket pass through the coordinator's serialized control path.
Notification callbacks only raise a coalesced target head; they never enqueue an
event directly.

Recovery follows this sequence:

1. Register the socket and its bounded queue in `recovering` mode before reading
   a head.
2. Ensure the node-level notification listener and authoritative repair loop
   are active. Hints received now only raise `target_head`.
3. In a short read-only `REPEATABLE READ` transaction, read one consistent
   folded state, digest, retained-event floor, fixed head `H`, and replay
   event/byte counts. Close the transaction before waiting on transport.
4. Through the coordinator, choose the active or terminal result and enqueue
   its welcome frame. A snapshot welcome includes the bounded snapshot;
   up-to-date has no content page. A terminal welcome skips content and
   completion frames and proceeds directly to bounded drain and close.
5. For replay, fetch immutable pages with `revision > cursor AND revision <= H`
   on transport demand. Only the next query cursor and range remain in memory;
   a page is fetched and enqueued only after an exact `recovery_ack` releases
   the prior page. Retention forbids deletion of these rows during active
   recovery.
6. After the snapshot or final replay page is acknowledged, or after an
   up-to-date welcome is handed to transport, enqueue `recovery_complete(H)`
   and set `enqueued_revision = H`. Hints accumulated during recovery remain
   only in `target_head` until this point.
7. For an active result, read the exact contiguous suffix
   `(enqueued_revision, target_head]`, enqueue each revision once, and advance
   `enqueued_revision` only after a successful queue reservation. A terminal
   result drains and closes without entering live mode.
8. Repeat suffix reads while hints raise the target. For one finite observed
   target, atomically change the socket to `live` at its enqueued revision.
   Later hints begin a new exact suffix read after that revision.
9. Compare every active coordinator's cursor with Postgres at least every five
   seconds and immediately after a gap, queue overflow, listener restart, or
   node resume.

The bounded queue preserves `recovery_complete(H)` before event `H + 1` on the
wire. A hint that races any step can only raise the target. Exact revision
checks suppress duplicates and detect omissions. Fault tests pause execution at
every barrier transition and notification boundary.

Local replicas reject a gap, unknown event, invalid payload, or impossible
transition and replace themselves from Postgres. They never invent an event or
advance a cursor to silence an error.

`Fanout.Redis`, if later enabled, publishes the same opaque head hints. Tests
must prove identical durable results with Redis healthy, unavailable, flushed,
and removed. Redis failure cannot make durable control unready.

## Bounded command and socket work

Decoded commands never accumulate as payload-bearing messages in a
`GenServer` mailbox. `CommandAdmission` reserves capacity in a bounded local
table before starting a supervised decision task.

Initial hard bounds are:

- 32 queued or in-flight commands and 512 KiB of decoded command data per
  Session per node;
- 512 queued or in-flight commands and 16 MiB per node;
- eight simultaneous database decision tasks for one Session on one node;
- one-second Postgres pool checkout deadline;
- 750 ms lock deadline, two-second statement deadline, and three-second total
  decision deadline;
- a configurable Postgrex pool whose size is part of the launch envelope and
  whose waiting queue never exceeds the node command bound.

Because every node can accept work for the same Session, Postgres remains the
final serialization point. Excess work receives retryable `overloaded` before
any terminal receipt is promised. Admission capacity is always released in an
`after` path, including task crashes and socket loss.

Each socket owns a bounded ETS-backed outbound queue. Producers write payloads
to that queue and send at most one coalesced wake-up signal. They never send one
mailbox message per event. The socket pulls frames while the transport is
writable and hands at most one frame at a time to the WebSocket implementation.
That handoff marks the frame in flight while retaining its event, byte, and age
reservation. Only a cumulative `delivery_ack` for an exact sent revision and
state digest releases a retained live prefix. An exact `recovery_ack` releases
only its snapshot welcome or replay page after client application. Kernel and
WebSocket buffers therefore cannot bypass the queue bounds.

The queue closes only the slow socket when any limit is exceeded:

- 256 queued or transport-in-flight control events;
- 1 MiB encoded queued or transport-in-flight bytes;
- five seconds since the oldest queued event;
- five replay pages queued or awaiting application acknowledgement.

The close is retryable and includes the last successfully delivered revision
when safe. Recovery resumes from Postgres. Other sockets and command commits
remain responsive.

Coordinator and socket mailboxes contain only bounded, coalesced control
signals. Release tests assert mailbox length, ETS bytes, task counts, pool wait,
and outbound age continuously throughout each run.

## TypeScript client runtime

The production runtime lives under `sdks/typescript/client`; web and mobile apps
remain thin consumers.

The core owns these states:

```text
idle -> connecting -> authenticating -> recovering -> live
                                   \-> backoff -> connecting
live -> recovering | backoff | ended | stopped
```

It provides:

- one managed socket and explicit `start`, `stop`, and token-refresh behavior;
- heartbeat handling and bounded exponential backoff with jitter;
- browser online/offline and React Native app/network lifecycle adapters;
- one canonical durable replica plus a separate optimistic pending overlay;
- stable command IDs across every resend;
- exact-next event application, cross-language state-digest verification,
  duplicate suppression, and gap recovery;
- cumulative delivery acknowledgment after each live event is applied;
- ACK/event reconciliation in either order;
- snapshot replacement followed by deterministic pending-overlay reapplication;
- terminal rejection rollback and a typed user-visible failure;
- retryable dependency errors that retain the pending command;
- terminal hello handling that enters `ended` or rejoin-required without
  reconnecting;
- bounded diagnostics that exclude tokens, names, and payload bodies.

The pending store interface has in-memory, browser IndexedDB, and React Native
persistence adapters. Device-local SQLite or AsyncStorage may implement the
mobile adapter. The server does not treat client persistence as authority.

Client bounds are 256 pending commands, 1 MiB normalized pending bytes, and 24
hours from first local enqueue. Reaching a bound rejects new optimistic work
locally with a typed capacity error. Expired pending work is surfaced to the
application; it is not silently given a new command ID.

Golden v2 frames are decoded and re-encoded by Elixir and TypeScript. Real
browser tests connect the packaged TypeScript client to the real Elixir server
and real Postgres adapter.

## Retention and capacity

The full control event log and all receipts remain available while a Session is
active. They remain for seven days after Session end, then cleanup may delete
them according to the product retention policy. The folded terminal control row
is retained with the product Session unless that Session is deleted under a
separate product policy.

C6 independent-fold equivalence applies while the event history is retained.
Before deleting eligible history, cleanup writes the terminal revision, state
digest, event count, and cleanup timestamp into the control row and verifies one
final independent fold. After deletion, Chalk exposes terminal folded state but
does not claim that the deleted history remains independently auditable or
replayable. A longer audit archive requires a separate product retention
decision and durable archive specification.

Hard per-Session logical budgets protect the shared database:

- 250,000 participant-command events or 2 GiB of normalized event payload,
  whichever comes first;
- 500,000 command receipts or 4 GiB of normalized receipt data, whichever comes
  first;
- 2,048 lifecycle event rows and 32 MiB of fixed-charge lifecycle capacity;
- 2,048 lifecycle intent rows and 32 MiB of normalized intent payload;
- a 1 MiB exact canonical snapshot, including admitted growth reservations;
- at most 500 active participant sessions unless the product launch envelope
  declares and proves a different limit.

The control row maintains transactionally checked logical counters and
reservations. Every lifecycle event has a conservative 16 KiB reservation
charge, and every admitted participant has a 2 KiB maximum snapshot-entry
reservation until its join is folded. All API admission and sync application
transactions enforce:

```text
lifecycle_event_count + lifecycle_reserved_events <= 2,048
lifecycle_event_bytes + lifecycle_reserved_bytes <= 32 MiB
lifecycle_intent_count + lifecycle_reserved_intents <= 2,048
lifecycle_intent_bytes + lifecycle_reserved_intent_bytes <= 32 MiB
snapshot_bytes + snapshot_reserved_bytes <= 1 MiB
```

Session creation reserves one event and intent for Session end. Join admission
consumes one intent slot for the join and reserves two events—its join and one
future explicit removal—plus one future removal intent. Applying join consumes
the join-event reservation and preserves the removal event/intent reservations.
Admitting removal converts the intent reservation into a retained intent;
applying it consumes the event reservation. Admitting and applying Session end
likewise convert and consume its original reserves, then release every unused
participant reservation. Every lifecycle intent is bounded to a 16 KiB charge,
so event and intent terminal capacity remain independently protected. Ordinary
work and participant churn cannot make a valid active participant or the
Session impossible to terminate.

Logical command and intent bytes use normalized encoded lengths; physical
database and index growth is measured independently in load and soak evidence.
Participant commands or new joins at capacity receive retryable overload before
decision. Explicit removal and Session end use their protected capacity.

Cleanup uses small `SKIP LOCKED` batches, records rows and bytes removed, and
never deletes active-Session events, active-Session receipts, pending lifecycle
intents, or data inside the supported post-end window. Cleanup lag has an alert
and readiness does not hide it.

Database-capacity monitoring reserves the final 20 percent of provisioned
storage for WAL, indexes, lifecycle completion, and recovery. Crossing that
watermark stops new Session admission and ordinary participant commands through
a shared operational admission mode while preserving the lifecycle reserve.
The release load and failover runs prove that the reserve covers the declared
maximum active Sessions and participants; physical disk exhaustion is not
treated as a normal retry mechanism.

Diagnostic traces retain at most 10,000 spans or five minutes in node memory.
Passing harness traces may be sampled after invariant summaries are written.
The complete trace for a failing scenario is written to ignored artifacts
before any in-memory ring overwrites it.

## Database durability and recovery promise

The launch topology uses PostgreSQL 18 or a later explicitly qualified version
with `fsync`, `full_page_writes`, and checksums enabled. Production writes go to
one writable primary. Read replicas never resolve command receipts or recovery
heads.

The launch durability promise is zero acknowledged sync-decision loss after one
primary failure. It requires at least one synchronous standby and
`synchronous_commit = on` or stronger for sync decision transactions and API
Session create, join, remove, and end transactions. The Elixir Postgres adapter
and Go lifecycle transaction layer set and verify the transaction-effective
value. The topology manifest names a nonempty approved
`synchronous_standby_names` set and permits promotion only of a standby that
participated synchronously in acknowledging writes.

Before accepting durable commands, readiness observes the writable primary and
at least one matching `pg_stat_replication` row with `state = 'streaming'`,
`sync_state = 'sync'`, and WAL byte lag below the numeric launch-envelope
threshold. Release failover proof confirms that the automation promotes only an
approved synchronous participant. If the selected managed service cannot
provide this topology, the product durability promise and this acceptance gate
must be changed explicitly before launch; the application cannot manufacture
the guarantee.

Release proof kills the command task, sync node, backend connection, primary
process, and primary host boundary at controlled points before and after
`COMMIT`. After promotion it verifies every acknowledged receipt, event,
revision, and folded state. Backup/PITR restore is drilled into isolation and
the restored independent fold is compared with the stored fold. The same fault
matrix surrounds API Session and lifecycle commits and verifies that every
returned Session, participant admission, issued token, removal, and end intent
survives promotion.

## Operational contract

### Boot and configuration

Production boot fails when:

- the Stateholder adapter is Memory;
- the development token verifier is enabled;
- required environment values are missing or malformed;
- the database migration version is absent or too new for the release;
- the configured database endpoint is not the writable authority;
- neither the notification listener nor the authoritative head-repair loop can
  initialize;
- the declared synchronous durability prerequisite is unmet.

Optional Redis absence never blocks durable-control boot.

### Health and readiness

`/healthz` reports only that the BEAM and HTTP listener are alive. `/readyz`
returns success only when the node is not draining and all required checks pass:

- production adapter and verifier;
- writable-primary connectivity;
- compatible schema version;
- bounded pool checkout and authoritative head read;
- authoritative head-repair-loop health, with notification-listener status
  reported as an acceleration signal;
- required synchronous standby state;
- lifecycle-consumer health and acceptable pending-intent lag.

Readiness uses reads and startup transaction checks and creates no synthetic
durable customer-like row. The database observations include
`pg_is_in_recovery() = false`, the exact migration version, the configured
`synchronous_standby_names`, transaction-effective `synchronous_commit`, and
the matching streaming/sync replication row and lag. The oldest pending
lifecycle intent warns at five seconds and fails cluster lifecycle readiness at
30 seconds. Each node also fails readiness if its repair loop or lifecycle
consumer supervisor is not running.

Required probes run at least once per second. Two consecutive failures make the
node unready within two seconds; recovery requires three consecutive successful
checks spanning at least five seconds. The approved launch envelope supplies
the numeric WAL-lag ceiling and may tighten, but not silently relax, these age
and hysteresis limits. The response is bounded and contains no credentials or
customer identifiers.

### Graceful drain

On SIGTERM the node becomes unready within 500 ms, rejects new upgrades, stops
admitting commands, lets already-started decision transactions resolve for at
most their deadline, writes no local-only terminal result, and closes sockets
with retryable 1012 after bounded queues drain. There is no application writer
lease to transfer. Other nodes recover clients and authoritative suffixes from
Postgres.

### Telemetry

Metrics and structured traces cover:

- command admission, overload, outcome, duplicate, and decision uncertainty;
- Postgres checkout, transaction, lock, query, error, and receipt-resolution
  latency;
- event revision, local cursor, fanout hint lag, head-repair count, and gaps;
- recovery mode, replay pages/bytes, snapshot bytes, and time to live;
- sockets, participant sessions, local coordinators, queue events/bytes/age,
  task counts, and mailbox lengths;
- lifecycle pending age, apply attempts, failures, and completion latency;
- receipt/event retained rows and logical/physical bytes, cleanup lag, and
  lifecycle reserve;
- primary role, synchronous standby state, WAL/replication lag, and failover;
- SDK connection state, pending count/age, reconnect count, and convergence
  latency using redacted identifiers.

Every scenario has `run_id`, seed, tenant/session test IDs, node ID, command ID,
event ID, revision, transaction attempt, and injected-fault ID. Logs omit token
values, participant names, and command payload bodies.

### Release artifact

The release is a reproducible uniquely tagged artifact containing the Git SHA,
protocol version, migration compatibility range, build timestamp, and runtime
dependency versions. A production-equivalent local instance must boot, report
ready, accept a real v2 browser client, drain, restart, and recover before the
artifact can be handed off.

## Stress harness and release proof

The harness tests correctness first and throughput second. It exposes
independent dimensions with no named profiles:

- number of sync nodes;
- Sessions, participants, sockets, and subscriptions;
- command mix, rate, burst, and concurrency;
- cursor age and recovery mode;
- client read speed and network interruption schedule;
- Postgres topology and fault points;
- notification loss, delay, duplicate, and reorder schedule;
- node and process restart schedule;
- run duration and deterministic seed.

The release command reads an approved launch-envelope artifact that supplies
the expected concurrent sockets, active Sessions, hot-Session size, command
rate, geographic latency assumptions, and latency SLOs. The load gate runs at
the declared peak plus 30 percent headroom. Missing launch-envelope values are
an explicit release blocker; the harness does not invent product traffic.

### Required scenario families

1. **Pure model:** at least 100,000 generated operations per seed; independent
   fold, receipt model, and replica model checked after every operation.
2. **Postgres transaction:** real adapter conformance, concurrent decisions,
   stable rejection, command-ID conflict, and crash injection around every
   transaction boundary.
3. **Multi-node:** at least two unclustered BEAM nodes accept concurrent commands
   for one Session; node death and stale local state still produce one Postgres
   order.
4. **Notification:** hints are lost, duplicated, delayed, reordered, and
   disabled; exact head reconciliation heals every node.
5. **Transport:** real TCP peers stop reading, reconnect, duplicate frames,
   cross ACK/event order, and exercise snapshot and paged replay.
6. **Client:** the packaged TypeScript runtime runs in a real browser and Node
   test process against the real Elixir socket and persists pending commands
   across process restart.
7. **Lifecycle:** real API create/join/remove/end operations share the database
   with sync commands and prove generation-safe ordering.
8. **Database recovery:** connection loss, backend termination, primary failure,
   synchronous-standby promotion, isolated restore, and cleanup contention.
9. **Load and soak:** the approved launch envelope plus headroom runs for at
   least 60 minutes; an eight-hour soak shows bounded queues, tables, tasks,
   mailboxes, memory, and connection pools with no unexplained positive slope.

### Mandatory fault points

At minimum, deterministic hooks stop or disconnect execution:

- before connection checkout;
- after transaction begin;
- after Session row lock;
- after receipt lookup;
- after rejected-receipt insert;
- after event insert;
- after folded-state update;
- after committed-receipt insert;
- immediately before `COMMIT`;
- after the server sends `COMMIT` but before it sees the result;
- after commit and before local cache update;
- after notification and before outbound enqueue;
- after outbound enqueue and before ACK;
- during snapshot/replay catch-up;
- while the peer is not reading.

After every injected fault, the harness resolves the command key from the
writable authority, independently folds the event log, compares the stored
folded state, checks exact revisions, reconnects replicas, and verifies that
every terminal result remains stable.

### Failure artifacts

Every run writes to:

```text
.artifacts/sync/<git-sha>/<run-id>/
  manifest.json
  verdict.json
  trace.jsonl
  server.log
  client.log
  postgres.log
  metrics.json
  failure.md
  reproducer.json
```

`manifest.json` records the seed, exact dimensions, fault schedule, commit,
artifact identity, protocol version, migration version, database settings, and
dependency versions. `verdict.json` is binary and lists every invariant.

On failure, `trace.jsonl` contains the complete scenario trace from setup
through verdict. `failure.md` leads with the
violated invariant, exact observed mismatch, first bad revision or receipt,
minimal reproduction command, and relevant trace IDs. The harness attempts
deterministic shrinking without replacing the original trace.

Raw artifacts remain ignored because they may be large. Each implementation
milestone rewrites one redacted human report at
`scratchpad/sync-production-readiness-report-YYYY-MM-DD.md`. Any harness error,
missing artifact, skipped required fault, unresolved command, or invariant
failure produces a failing exit status and blocks release.

## Verification gates

### Focused correctness

- all six confirmed breaker failures are converted to passing assertions;
- Memory and real-Postgres semantic conformance pass;
- reducer and database revision constraints agree;
- 100,000-operation model runs retain the existing passing boundary;
- every stable rejection and committed outcome survives process and node
  restart;
- unknown commit results resolve by receipt without duplicate effect;
- exact event fold equals the stored fold at every checkpoint.

### Integration

- two nodes concurrently accept one Session's commands;
- Postgres notification loss heals from the durable log;
- API lifecycle transactions and sync event application are idempotent;
- socket loss creates no durable participant leave;
- real TypeScript clients converge through retry, restart, replay, snapshot,
  ACK/event reorder, and Session end;
- a slow TCP peer reaches a bounded disconnect while healthy peers continue.

### Operations and recovery

- migration apply, rollback-safe expand/contract behavior, and schema snapshot
  verification pass;
- production config refuses Memory and incompatible schemas;
- readiness follows database and lifecycle-consumer health;
- SIGTERM drain preserves in-flight decisions and recovers clients elsewhere;
- primary failover preserves the stated acknowledged-write guarantee;
- cleanup respects active and post-end retention and lifecycle reserve;
- load and soak satisfy the approved envelope and every declared bound.

### Repository gates

Completion requires execution and observation of the applicable focused gates
and the root gate:

```text
apps/sync/scripts/gate.sh
apps/api/scripts/gate.sh       # whenever API, Go, or migrations change
pnpm run gate
```

Nontrivial implementation also receives the repository's required automated
code review. No failing test may be deleted, skipped, or weakened to obtain a
green result.

## Implementation phases

### Phase 0 — Set the authority and contract

- update `apps/sync/README.md`, `apps/sync/AGENTS.md`,
  `docs/redesign/north-star.md`, and the active architecture record so they name
  Postgres as durable authority and Redis as optional;
- finalize Session and participant-session identity and lifecycle transitions;
- add the Postgres migration design, constraints, retention, and launch
  durability settings;
- add and generate the strict v2 contract while freezing v1 outputs;
- record the approved launch envelope and operational SLOs.

Exit gate: documents, schema tests, generated goldens, and migration plan agree
on one authority, one identity, one protocol, and one launch promise.

### Phase 1 — Build the single-node durable core

- add Postgrex and the Postgres Stateholder semantic transaction;
- create revision-zero Session state and durable events and receipts;
- make the reducer total and exact-next;
- remove the 256-entry cache as authority;
- resolve uncertain commits through receipts;
- convert the restart, eviction, ambiguity, conflict, and revision breakers to
  passing assertions against real Postgres;
- keep Memory as a deterministic conformance adapter only.

Exit gate: all decision invariants and five non-backpressure confirmed failures
pass under crash injection on one node and real Postgres.

### Phase 2 — Bound delivery and recovery

- replace payload-bearing direct fanout with bounded outbound queues;
- implement snapshot, paged replay, up-to-date, and exact live catch-up;
- add notification hints and periodic head repair;
- enforce frame, payload, queue, admission, task, pool, and retention limits;
- test a real slow TCP peer and convert the mailbox-growth breaker to a passing
  bounded-delivery assertion.

Exit gate: recovery is gap-free under notification faults, and every server
resource plateaus under slow and reconnecting clients.

### Phase 3 — Integrate lifecycle and the SDK

- migrate API Session and participant-session lifecycle rows and intents;
- apply join, remove, and end intents idempotently through the control log;
- remove socket-driven durable leave;
- implement the TypeScript connection, replica, pending-overlay, persistence,
  diagnostics, and lifecycle runtime;
- prove real browser and React Native-compatible core behavior against the real
  server.

Exit gate: API, server, and TypeScript tests prove generation-safe lifecycle
ordering and convergence through all v2 recovery and command outcomes.

### Phase 4 — Prove multi-node and operational behavior

- run two or more independent sync nodes against one Postgres authority;
- add dependency-aware readiness, drain, telemetry, cleanup, and unique release
  artifacts;
- exercise concurrent hot Sessions, node loss, lost hints, pool pressure,
  rolling versions, and synchronous-standby promotion;
- confirm Redis is absent from the correctness path.

Exit gate: multi-node, failover, migration, readiness, drain, and compatibility
campaigns pass with one event history and stable receipts.

### Phase 5 — Release proof

- run the full deterministic, real-wire, browser, lifecycle, failover, load, and
  eight-hour soak matrix against the uniquely identified artifact;
- run focused gates, root gate, and automated review;
- write the redacted failure-first production-readiness report;
- list any external production deployment prerequisites separately from the
  implementation verdict.

Exit gate: every required verdict is green, every artifact is present, and the
binary implementation status is `done`. Production deployment remains a
separate explicitly approved action.

## Ownership map

| Concern                       | Primary location                                          | Required proof                                          |
| ----------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| Reducer and local coordinator | `apps/sync/lib/chalk_sync/sessions/`                      | model, exact-next, restart, and local lifecycle tests   |
| Durable decisions             | `apps/sync/lib/chalk_sync/stateholder/postgres.ex`        | real-Postgres atomicity and crash matrix                |
| Database schema               | `apps/api/db/migrations/`, `apps/api/db/schema.sql`       | apply, constraints, plans, and compatibility            |
| Lifecycle API                 | `apps/api` plus lifecycle-intent consumer in `apps/sync`  | join/remove/end concurrency tests                       |
| Protocol source and codegen   | `contract/schema/`, existing generators                   | v1 stability and v2 cross-language goldens              |
| Socket recovery and bounds    | `apps/sync/lib/chalk_sync/transport/`                     | real-wire gap and slow-peer tests                       |
| TypeScript runtime            | `sdks/typescript/client`                                  | unit, persistence, browser, and real-server tests       |
| Optional Redis acceleration   | future `fanout/redis.ex`                                  | zero correctness difference when removed                |
| Harness and reports           | `apps/sync/test`, `apps/sync/scripts`, `.artifacts/sync/` | deterministic binary verdict and complete failure trace |
| Operations and release        | sync config, release files, repository CI                 | boot, readiness, drain, failover, soak, root gate       |

## Traceability to confirmed failures

| Confirmed failure                       | Required correction                                    | Release evidence                                                        |
| --------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| outcomes lost after writer restart      | durable Postgres receipts                              | retry returns original result after all node heaps are deleted          |
| outcome forgotten after 256 later IDs   | active-Session receipt retention                       | oldest retained ID remains stable beyond former cache size              |
| commit succeeds without recoverable ACK | receipt-based commit resolution                        | fault after `COMMIT` returns committed/duplicate, never false rejection |
| revision conflict leaves empty writer   | coordinator is disposable and loads only from Postgres | no empty authority process or transient restart loop                    |
| non-reading subscriber mailbox grows    | bounded ETS outbound queue and coalesced wake-up       | real slow TCP peer disconnects at the declared bound                    |
| reducer accepts non-contiguous revision | total exact-next reducer and DB check                  | gap is rejected without state mutation or crash                         |

## Definition of done

The overhaul is done only when all statements below are observed true:

- Postgres is the sole durable authority for control state, events, receipts,
  lifecycle facts, and lifecycle delivery intent.
- Redis and all BEAM state can be deleted without losing an acknowledged
  outcome.
- Authority is tenant- and Session-scoped and participant generations are
  enforced.
- Every command has at most one terminal receipt and at most one event.
- Event append, folded-state update, revision increment, and committed receipt
  are one transaction.
- Terminal rejection is stable and changes no control revision.
- Unknown commit status resolves through the writable-primary receipt.
- Every retained event is exactly next, independent fold equals stored state,
  and post-retention cleanup records the verified terminal checkpoint.
- All six confirmed breaker failures pass as corrected engine assertions.
- Socket loss never becomes durable participant removal.
- Join, remove, and Session end are transactionally intended, idempotently
  delivered, and generation-safe.
- Two or more nodes concurrently serve one Session with one Postgres order and
  no application writer lease.
- Lost fanout hints heal from the authoritative head and event log.
- TypeScript clients converge through ACK/event reorder, retry, restart,
  reconnect, replay, and snapshot.
- Every declared queue, mailbox, task set, pool, frame, replay, receipt set,
  event set, trace, and cleanup process remains bounded.
- Required migrations are applied and verified.
- Real Postgres failover satisfies the declared acknowledged-write guarantee.
- Focused, API, multi-node, SDK, load, chaos, soak, sync, and monorepo gates are
  green.
- The unique release artifact boots with production configuration, reports
  dependency-aware readiness, serves a real v2 client, drains, and recovers.
- The final report contains zero invariant failures, zero harness errors, no
  skipped required scenario, and a binary `done` implementation verdict.

Until every item is green, the sync engine remains not production-ready.
