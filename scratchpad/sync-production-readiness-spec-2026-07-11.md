# Chalk Sync Server Production-Readiness Specification

<!-- cspell:words appendfsync erpc failback fsyncs goldens libcluster parameterizes Redix testdata transactionally WAITAOF -->

Status: Proposed for implementation
Date: 2026-07-11
Scope: correctness, reliability, multi-node authority, client convergence,
resource safety, operations, and release proof for the declared sync protocol.

## Decision

Chalk will complete the current sync architecture instead of rebuilding it.
The Stateholder remains the authoritative coordination boundary. A session
writer is a disposable, fenced working copy. WebSocket processes own transport
state only. SDK clients maintain revisioned replicas and recover by exact replay
or complete snapshot.

The implementation is production-ready only when every terminal command
outcome is recoverable after process and node loss, every event belongs to one
contiguous authoritative order, every client can prove its position in that
order, slow consumers cannot create unbounded resource growth, and the declared
failure matrix passes against real Redis and multiple sync nodes.

The baseline storage target is Redis 7.2 or newer with one writable primary,
two promotion-eligible replicas, AOF enabled with `appendfsync always` on all
three nodes, `min-replicas-to-write 2`, `min-replicas-max-lag 1`, and Sentinel
configured to promote only a replica that participated in the acknowledged
durability barrier. `WAITAOF 1 2 <deadline>` is the minimum post-mutation
barrier. The exact launch topology may replace this baseline only when it
provides equal or stronger semantics and passes the same failure proof. A
topology that cannot prove those semantics is not an approved Stateholder.

Exactly two replicas are promotion-eligible in the baseline, and every
acknowledged write waits for both. Redis replica count alone is insufficient
because `min-replicas-to-write` ignores Sentinel promotion priority. The
topology controller maintains a separate durable write gate and topology
generation. It disables the gate before any replica membership or eligibility
change, admits a replacement only after full synchronization and a barrier
checkpoint, then enables the gate when exactly two directly verified replicas
are both online and promotion-eligible. Every mutation script verifies the
current gated topology generation in addition to Redis's replica-count check.
Readiness is false while the gate is disabled. Release proof races writes with
every gate, membership, priority, and synchronization transition.

This specification turns the existing learning model and breaker findings into
one executable contract. It does not authorize a second sync rewrite.

## Product intent

The sync server makes live Chalk state feel immediate while preserving a
stronger rule: a fast answer may never weaken correctness. A participant may
disconnect, retry, reconnect through another node, miss an acknowledgement, or
observe a delayed event without producing duplicate effects, contradictory
outcomes, revision gaps, or silent divergence.

The same language-neutral contract serves the first-party app and every public
SDK. TypeScript is the first production client implementation, not a privileged
protocol dialect.

## Meaning of “production-ready”

This specification makes the declared `session.control` sync contract ready for
production. The first command surface may remain small, but every advertised
command and event must satisfy the complete contract.

A production-ready claim covers:

- authoritative state and stable command outcomes;
- contiguous event ordering and deterministic replay;
- reconnect and acknowledgement recovery;
- multi-node ownership, fencing, and fanout recovery;
- bounded subscriber, writer, event, and receipt resources;
- a real TypeScript client replica and reconciliation loop;
- dependency-aware readiness, telemetry, release artifacts, CI, load, chaos,
  and soak evidence.

It does not claim that every future Chalk stream or meeting feature is shipped.
Unsupported streams and commands must remain absent from the public contract
instead of appearing as placeholders.

## Scope

### In scope

- `session.control`, beginning with the current participant and hand-state
  behavior and providing the foundation for later control commands;
- the language-neutral sync schema and generated Elixir and TypeScript types;
- the Elixir sync server, Memory Stateholder, Redis Stateholder, and authority
  coordination;
- the TypeScript SDK transport, replica, pending-command queue, diagnostics,
  and reconnect loop;
- deterministic breaker, real-wire, real-Redis, multi-node, load, and soak
  verification;
- production build, configuration, health, readiness, graceful shutdown, and
  CI boundaries.

### Outside this specification

- media transport and WebRTC behavior;
- whiteboard merge semantics, CRDTs, and operational transformation;
- chat, transcript, recording artifact, and file persistence;
- presence payload design beyond separating volatile connection presence from
  durable session control;
- adversarial cybersecurity testing, token cryptography, key rotation, abuse
  prevention, and end-to-end encryption;
- production deployment or production traffic changes.

The sync server consumes verified identity and capability claims. The separate
authentication and authorization launch gate must still pass before Chalk as a
whole is production-ready. This specification does not weaken or bypass that
gate.

## Canonical language

### Room

A durable product container that may host many meeting occurrences. A Room is
not a live sync authority boundary.

### Session

One live occurrence inside a Room. All control revisions, events, command
receipts, writer ownership, snapshots, replay cursors, and cleanup lifetimes are
scoped to one Session.

### Participant session

One participant identity inside one Session. It is the idempotency actor scope
and may have multiple simultaneous WebSocket connections. It is not a native
Chalk User.

### Session key

`{tenant_id, session_id}`. Every Stateholder key and writer-ownership decision
uses this namespace. `room_id` remains contextual metadata and cannot identify
live state by itself.

### Command key

`{tenant_id, session_id, participant_session_id, command_id}`. A command ID is
generated once as UUIDv7 by the client and reused unchanged across every retry.
Its embedded time establishes the supported retry and receipt-retention window.
Using Stateholder time, a new command ID is admissible only when its timestamp is
no more than 24 hours old and no more than five minutes in the future. Malformed
IDs return `invalid_command`; future IDs return `command_clock_skew`; old IDs
return `command_expired`. Receipt lookup precedes age rejection, so a retained
terminal outcome remains resolvable at the boundary. Golden boundary vectors are
shared by Elixir and TypeScript.

### Server-cause key

`{tenant_id, session_id, cause_kind, cause_id}`. Server-driven admission,
control-plane removal, reconnect-grace expiry, and Session-end work uses the
same atomic decision semantics as a client command. Explicit client leave is
excluded. A cause ID is issued once by the control-plane event or derived
deterministically from the lifecycle generation that created the work.

Each cause also carries `participant_session_generation | session_generation`,
`issued_at`, and `expires_at` signed or supplied by its authoritative issuer.
The Stateholder rejects a cause outside that delivery interval or for an older
generation, even after its full receipt has compacted. Terminal generation
tombstones survive through the maximum token and cause lifetime.

API-driven causes additionally carry a stable `lifecycle_intent_id` that does
not change across delivery generations or cause IDs. The Stateholder atomically
indexes that intent to its first committed or intent-terminal receipt and
revision. Cause-scoped delivery rejection such as `cause_expired` is recorded
only under the individual cause key and cannot finalize or poison the intent
index. Receipt lookup first returns an existing individual cause receipt. Only
a cause key with no receipt checks the committed or intent-terminal index; a
pending intent may accept one later valid delivery generation. A reissued cause
therefore resolves committed work without emitting another event, while
retrying an expired earlier cause always returns its own stable rejection.

### Command receipt

The authoritative terminal outcome of one command key, including the request
fingerprint and either its committed revision/event or stable rejection reason.
A receipt is durable for the idempotency lifetime.

### Event

One authoritative control transition in a Session. It carries an event ID,
stream, base revision, next revision, name, payload, and the originating command
ID when a client command caused it.

### Snapshot

A complete replacement projection of one stream at one declared revision. A
snapshot is sufficient to heal a replica without hidden prior state.

### Writer

The single active Elixir process allowed to validate and order commands for one
Session. Its heap is a disposable working copy. Its lease and fencing token,
not the local process registry, establish authority.

### Replica

A client or non-authority node projection derived from a snapshot plus a
contiguous suffix of authoritative events.

## Authority and system boundaries

The ownership chain is:

```text
Stateholder record and event stream
    -> fenced session writer working copy
        -> local and cross-node fanout
            -> SDK client replica
```

The Stateholder owns:

- the current Session control snapshot and revision;
- the retained authoritative event sequence;
- command receipts and request fingerprints;
- writer lease state, active authority epoch, and monotonically increasing
  in-epoch fencing counter;
- the durable head used to detect fanout lag.

The session writer owns:

- deterministic command validation against its current authoritative
  projection;
- serialization of commands for its Session;
- a hot receipt cache that is an optimization only;
- local subscriber registration and lifecycle;
- publishing committed events after the authoritative commit.

A WebSocket process owns:

- protocol phase and connection state;
- one verified participant-session identity;
- bounded outbound delivery;
- forwarding commands to the authority;
- converting authoritative outcomes into protocol frames;
- reconnect or snapshot-replacement signals when continuity cannot be
  maintained.

The TypeScript client owns:

- the canonical server replica and its revision;
- optimistic pending commands as a separate overlay;
- command IDs across retries;
- strict event application and gap detection;
- snapshot replacement, replay, acknowledgement reconciliation, and reconnect.

Postgres continues to own durable product facts such as Room and Session
records. Real-time control state does not move to Postgres as part of this work.

## Correctness invariants

These invariants are release blockers.

### C1. Correct authority key

Live state is partitioned by `{tenant_id, session_id}`. A Room with two Sessions
has two independent revision sequences, writers, event streams, receipts, and
snapshots. No key can collide across tenants, Sessions, or participant sessions.

### C2. One fenced writer

At most one writer fencing token can commit for a Session. A stale or partitioned
writer is rejected before mutation even when its local process is still alive.
Only the token returned by the latest atomic acquisition and paired with its
unexpired lease is valid. A numerically larger caller-supplied token has no
authority.

### C3. Atomic command decision

One Stateholder operation atomically establishes the command receipt and, for a
commit, the event, next snapshot, and next revision. No observer can see only a
subset of that unit.

Primary mutation is not yet an externally visible decision. The Stateholder
returns a terminal result only after the configured durability barrier succeeds.
Fanout, acknowledgement, and receipt resolution may expose the decision only
after that barrier. A barrier timeout leaves the outcome uncertain and
unpublished until resolution either re-establishes durability or proves the
mutation absent after authoritative failover.

### C4. Stable terminal outcome

Every retry of the same command key and request fingerprint returns the same
semantic terminal outcome for the full idempotency lifetime:

- an original commit returns `duplicate` with the original revision;
- an original terminal rejection returns the same rejection reason;
- neither path emits another event or side effect.

A command ID reused with a different command name or payload returns
`command_id_conflict` and performs no mutation. This guarantee covers the
24-hour supported retry window. A UUIDv7 command ID outside that window returns
`command_expired` and can never start new work.

### C5. Honest acknowledgements

`committed` means the event, snapshot, revision, and recoverable receipt are
authoritative. `duplicate` points to the original committed revision.
`rejected` is a terminal business outcome and guarantees no mutation occurred.

Transport loss, Stateholder timeout, writer loss, and unknown commit status are
not business rejections. The server resolves the durable receipt or closes the
connection with a retryable recovery signal. The client retries the same command
ID and never invents success or rejection from transport loss.

### C6. Exact event chain

For every event:

```text
event.base_revision == current_revision
event.revision == event.base_revision + 1
```

The production reducer returns an explicit error for a gap, unknown event,
invalid payload, duplicate participant identity, or semantically invalid state
transition. It never advances to a supplied arbitrary revision.

### C7. Command/event correlation

Every unique committed command key produces exactly one event carrying its
`command_id`, regardless of the number of transport attempts. Every terminally
rejected command produces no event. Every unique committed server-cause key
produces exactly one event carrying its `cause_id`; it never fabricates a client
command ID. Lifecycle retries resolve the original server-cause receipt.

### C8. Snapshot and replay equivalence

A snapshot at revision `n` equals the independent fold of the authoritative
event prefix through `n`. Replay from cursor `c` to head `n` is the exact ordered
suffix `(c, n]`; an equivalent final state produced by different events is not
accepted as correct replay.

Snapshots and events use RFC 8785 JSON canonicalization. The state-digest
projection contains exactly `record_schema_version`, tenant, Room, Session,
control revision, status, and participant control state. It excludes
`state_digest`, `chain_digest`, `updated_at`, transport metadata, and every other
derived or volatile field. `state_digest` is the lowercase hexadecimal SHA-256
of that projection's UTF-8 RFC 8785 encoding.

At revision zero, `chain_digest` is SHA-256 of the UTF-8 bytes
`chalk.sync.v2.chain.genesis\n` followed by the raw 32 state-digest bytes. For
event `n`, `chain_digest` is SHA-256 of the raw 32 previous-chain-digest bytes
followed by the UTF-8 RFC 8785 encoding of the complete event excluding only
`chain_digest`. The event includes the resulting `state_digest` and
`previous_chain_digest` in that encoded input. This order removes any circular
digest dependency.

JSON nulls, integers, strings, Unicode, and object ordering follow RFC 8785;
payloads that cannot be represented by the schema and canonicalizer are
rejected. Elixir and TypeScript consume golden genesis, event, snapshot,
compaction, and Unicode vectors. A replica at the correct revision with the
wrong state or chain digest is corrupt and must replace its state from a
snapshot.

### C9. Gap-free welcome cut

Joining or reconnecting creates one linearized cut. The welcome represents a
declared head revision, and subsequent live delivery begins strictly after that
head. Events committed while the welcome is assembled are buffered or replayed;
they cannot disappear between recovery and subscription.

### C10. Replica convergence

After all accepted messages are delivered or recovery completes, every correct
replica at revision `n` equals the authoritative projection at `n`. A replica's
observed authoritative revision never decreases.

### C11. Bounded resources

No participant, subscriber, Session, event tail, command receipt set, trace,
retry loop, or process mailbox grows without an explicit bound or lifecycle.
Crossing an outbound subscriber bound disconnects that subscriber into the
normal replay/snapshot recovery path without blocking the writer.

### C12. Acknowledged durability

An acknowledged terminal command outcome survives writer loss, sync-node loss,
and the supported Redis primary-failover configuration. Authority fencing
tokens never regress across crash, promotion, failback, restore, or authority
record loss. Missing or regressed authority metadata beside existing Session
state is corruption and makes that Session unavailable. If the configured
Stateholder cannot establish these properties, the server cannot return a
terminal acknowledgement.

Fences are `{authority_epoch, counter}` pairs. `authority_epoch` is a random
128-bit value owned outside restored Redis data by the topology controller.
Normal acquisitions increment the Redis counter within one epoch. Before backup
restore, disaster recovery, or cluster replacement begins, the topology
controller durably disables the write gate and makes the target Redis endpoint
unreachable to every sync node. It restores data into that isolated endpoint,
rotates and durably installs a new authority epoch, verifies the barrier and
topology generation, then exposes the endpoint and enables writes in that order.
Mutation requires exact equality with the active epoch and counter, so a stale
writer from the pre-restore epoch cannot commit even when the restored counter
repeats. Restore without prior gate disablement, endpoint isolation, and epoch
rotation is forbidden and covered by release proof.

## Authoritative data model

The adapter may encode these records differently, but their semantics are
portable and covered by Stateholder conformance tests.

### Session control record

```text
SessionControl {
  record_schema_version
  tenant_id
  room_id
  session_id
  control_revision
  state_digest
  chain_digest
  status
  participants_by_participant_session_id
  updated_at
}
```

`status` is at minimum `active | ended`. Participant control state is keyed by
participant-session identity. Volatile socket presence is not stored here.

### Control event

```text
ControlEvent {
  record_schema_version
  event_id
  tenant_id
  room_id
  session_id
  stream = "control"
  base_revision
  revision
  name
  participant_session_id | null
  command_id | null
  cause_id | null
  previous_chain_digest
  chain_digest
  state_digest
  payload
}
```

`event_id` and `revision` identify delivery. `command_id` correlates optimistic
client work with its authoritative result. `cause_id` identifies server-driven
lifecycle work without pretending it was a client command.

### Command receipt

```text
DecisionReceipt {
  record_schema_version
  tenant_id
  session_id
  actor_kind = participant_command | server_cause
  participant_command = {
    participant_session_id
    participant_session_generation
    command_id
    command_timestamp
  } | null
  server_cause = {
    cause_kind
    cause_id
    lifecycle_intent_id | null
    issuance_generation
    issued_at
    cause_expires_at
  } | null
  request_fingerprint
  outcome = committed | rejected
  validated_revision
  revision | null
  event_id | null
  rejection_reason | null
  recorded_at
  expires_at
}
```

The request fingerprint is
`jcs-sha256-v1:<lowercase hexadecimal SHA-256>`. Its input is an RFC 8785
canonical JSON object containing the actor scope, command name, and
schema-validated payload. Unknown payload fields are rejected before hashing.
The protocol repository contains golden Unicode, number, key-order, and nested
payload vectors consumed by Elixir and TypeScript. The fingerprint detects reuse
of one command ID for different intent without storing duplicate payloads.

For participant commands the actor scope contains tenant, Session,
participant-session ID and generation, command ID, name, and payload. For server
causes it contains tenant, Session, cause kind, cause ID, optional lifecycle
intent ID, issuance generation, issued-at, expiry, name, and payload. Timestamps
use RFC 3339 UTC with exactly millisecond precision before canonicalization.

Committed receipts record the event base revision in `validated_revision` and
the resulting revision in `revision`. Rejected receipts record the revision
against which the rejection was validated and have no event or result revision.
`duplicate` is a response derived from an existing committed receipt; it is not
a third stored outcome.

The receipt schema is a tagged union. `actor_kind = participant_command` requires
`participant_session_id`, `participant_session_generation`, `command_id`, and
`command_timestamp`. `actor_kind = server_cause` requires `cause_kind`,
`cause_id`, `issuance_generation`, `issued_at`, and `cause_expires_at`. Fields
from the other variant are forbidden. Both variants include fingerprint,
outcome, validated revision, result references, decision time, and receipt
expiry. The Stateholder exposes `resolve_command/1` and `resolve_cause/1`; both
use the same atomic decision implementation and conformance suite.
API lifecycle work also exposes `resolve_lifecycle_intent/1`, backed by the
atomic intent index rather than a scan of cause receipts.

### Writer authority

```text
WriterAuthority {
  record_schema_version
  tenant_id
  session_id
  owner_node_id
  authority_epoch
  fencing_counter
  lease_expires_at
}
```

Fencing counters increase on every acquisition within one authority epoch.
Every authoritative command operation validates the epoch and counter
atomically.

## Stateholder contract

`ChalkSync.Stateholder` must be redesigned around semantic operations instead
of treating Redis as a mechanical replacement for ETS.

The portable boundary must support:

- reading one consistent Session view containing the snapshot, revision, state
  digest, chain digest, event floor, durability generation, record version, and
  authority metadata;
- acquiring, renewing, and releasing writer authority;
- atomically recording a committed command decision;
- atomically recording a terminal rejection against the validated revision;
- resolving an existing command receipt, server-cause receipt, or lifecycle
  intent index by its stable key;
- reading the exact event suffix after a cursor;
- reading the authoritative head for lag detection;
- subscribing to or being notified of head advancement;
- ending a Session and applying its retention lifecycle;
- health and readiness checks;
- explicit unavailable, timeout, stale-fence, revision-conflict, cursor-unavailable,
  command-ID-conflict, and corruption errors.

The commit operation verifies all of the following before mutation:

1. Stateholder time is strictly before the current lease expiry;
2. the writer authority epoch and fencing counter are the pair bound to that
   lease;
3. the expected revision equals the authoritative revision;
4. the command or server-cause key has no conflicting receipt;
5. the event is exactly the next revision;
6. the new snapshot and digest are the valid result of the event.

Receipt lookup, validation, and terminal rejection use one compare-and-set
operation. The operation returns an existing receipt first. Otherwise it writes
the rejection only if its validated revision is still current; a revision race
returns `revision_conflict` for reload and revalidation.

All lease acquisition, renewal, expiry, takeover, and commit comparisons use
Redis server time inside the atomic operation. Expiry is exclusive: a lease
cannot commit when `server_time >= lease_expires_at`. Renewal failure stops
admission of new commands immediately. An operation already in flight remains
safe because its commit repeats the token and expiry checks atomically. Lease
duration and renewal cadence are configuration constrained to exceed measured
99.99th-percentile VM pause plus the Stateholder operation deadline by at least
two renewal intervals.

The Memory and Redis adapters run the same conformance suite. Memory remains
dev/test-only and may not satisfy production configuration validation.

## Redis production adapter

Redis is a correctness component, not an unexamined cache.

The adapter must:

- namespace every key by tenant and Session;
- keep all records touched by one atomic operation in a compatible Redis key
  slot;
- implement command decision and fencing checks as one atomic server-side
  operation;
- verify the topology controller's enabled write gate and generation in every
  mutation;
- store the current snapshot, head, event floor, state and chain digests,
  durability generation, fencing counter, and lease metadata in one
  hash-slot-compatible aggregate whose read is atomic;
- retain an authoritative ordered event tail and current snapshot;
- use Pub/Sub only as an optional wake-up signal, never as the sole event
  record;
- recover a missed or final dropped notification by comparing the local cursor
  with the authoritative head and reading the missing suffix;
- expose connection, command, replication, persistence, stream-lag, and
  readiness failures explicitly;
- fail closed for mutations when durability or authority is uncertain;
- pass immediate process loss and supported primary-failover tests after an
  acknowledged commit.

The mutation script and durability barrier are distinct steps:

1. reserve one exclusive Redis connection to the current primary;
2. execute the atomic mutation on that connection, writing a unique
   `durability_generation` into the aggregate and decision;
3. without releasing the connection or interleaving unrelated writes, execute
   `WAITAOF 1 2 <deadline>` for local and both replica fsyncs;
4. expose the receipt and event only after the barrier succeeds;
5. on timeout, suppress fanout and terminal acknowledgement;
6. on connection loss or later resolution of an existing unproved decision,
   reserve a new exclusive connection to the authoritative primary, atomically
   verify the decision and write an idempotent durability marker for its
   generation, then run `WAITAOF` on that same connection before exposure;
7. after authoritative failover, an absent decision may be retried only after
   the adapter proves the new primary's epoch and durable head.

Raw Redis records may contain an unproved generation between mutation and
barrier. They are private adapter storage. Every semantic Stateholder read,
receipt resolution, head read, suffix read, and fanout path either carries a
connection-local durability proof for that generation or runs the marker and
barrier sequence before returning it. No protocol or writer observer can see an
unproved receipt, head, snapshot, or event. A pooled or replacement connection
cannot reuse another connection's `WAITAOF` result.

Lease acquisition and renewal, fencing-counter advancement, snapshots, events,
receipts, and tombstones use the same barrier. The adapter configures and checks
the minimum replica constraints at readiness. Loss of either required replica
makes mutations fail closed.

The baseline guarantee is RPO zero for acknowledged outcomes under primary
process or host loss, promotion of a barrier-confirmed replica, replica restart,
and controlled failback. The campaign also partitions the primary from its
replicas and quorum; the isolated primary must stop accepting mutations.
Simultaneous loss of the primary and both fsynced replicas is outside this
availability guarantee and is reported as unrecoverable storage loss rather
than silently reconstructed history.

Conformance tests swap pooled connections, inject unrelated writes, drop the
exclusive connection between mutation and barrier, read every semantic surface
during that window, kill the primary before and after barrier completion, and
perform failback. No unproved generation may escape, and every acknowledged
generation must remain present.

## Writer ownership and multi-node routing

The production topology permits WebSocket connections for one Session to land
on multiple sync nodes while maintaining one fenced writer.

The first implementation uses `libcluster` for node discovery and Erlang
distribution for authenticated node-to-node command forwarding. A
`ChalkSync.Cluster.NodeRouter` resolves the `owner_node_id` from the Stateholder
and performs a bounded `:erpc` call to `ChalkSync.Sessions.SessionServer` on that
node. A routing timeout is uncertainty, never rejection. The origin resolves the
receipt or lets the client retry. Redis Pub/Sub carries coalesced head-advanced
hints; `ChalkSync.Sessions.Fanout` reads the retained authoritative suffix and
never treats the hint payload as state. Redis remains the authority if cluster
membership and owner discovery disagree.

1. The first node requiring authority acquires a renewable Session lease and a
   new fencing token.
2. Non-owner nodes register local subscribers and forward commands to the known
   owner through the cluster command-routing boundary.
3. The owner validates and commits through the Stateholder, then returns the
   durable outcome and publishes head advancement.
4. Every node with local subscribers advances its local projection from the
   authoritative event suffix. Notifications accelerate delivery; the retained
   event sequence heals loss.
5. The lease defaults to three seconds and renews once per second when the
   measured-pause constraint permits those values. Renewal failure immediately
   stops new owner work. Every commit still verifies the lease against Redis
   server time. A replacement owner receives a higher fencing token.
6. A stale owner cannot mutate even if delayed messages or a network partition
   later heal.
7. If command forwarding or the response is lost, the origin resolves the
   receipt or lets the client reconnect and retry the same command ID.

The local Elixir `Registry` remains process discovery inside one node. It is not
the cluster authority mechanism.

The two-node test topology starts named BEAM nodes with `libcluster`, one Redis
primary, two replicas, and Sentinel from
`apps/sync/test/support/redis_topology/`. Tests cover owner-cache staleness,
forward timeout, node disconnect, delayed `:erpc`, lease expiry during a VM
pause, and arbitrary higher or regressed fencing tokens.

## Protocol contract

The language-neutral schema remains the only protocol source of truth. Generated
Elixir and TypeScript files are never edited directly.

### Identity

Verified connection claims include `tenant_id`, `room_id`, `session_id`, and
`participant_session_id`. The Session key comes from verified claims, never an
untrusted frame field.

### Hello and welcome

The client declares its protocol version, desired streams, and last applied
`{revision, state_digest, chain_digest}` cursor per durable stream. For
`session.control`, the server responds with one of:

- `snapshot`: a complete replacement snapshot, control revision, state digest,
  and chain digest;
- `replay`: the exact events after the supplied cursor through the declared
  head and head digests;
- `up_to_date`: an explicit head revision and digests equal to the client cursor.

A missing, future, corrupt, or unavailable cursor produces a snapshot. Unknown
required protocol features fail explicitly rather than being ignored. A cursor
whose revision matches but either digest differs always produces a snapshot.

The gap-free cut is implemented in this order:

1. allocate a bounded pre-welcome queue and subscribe to coalesced head hints;
2. atomically read the consistent snapshot/head/digest view at revision `h`;
3. read and validate every retained event after `h` that arrived while the view
   was being installed;
4. send a welcome declaring `h` and its state and chain digests;
5. drain only the contiguous buffered suffix beginning at `h + 1`;
6. switch the same queue to live mode without replacing the subscription.

Head hints received before, during, or after the read cause an authoritative
head comparison, so a lost hint cannot create a gap. Buffer overflow, cursor
compaction, or a non-contiguous suffix restarts the cut from a fresh snapshot up
to three times, then closes with the retryable `recovery_overloaded` signal.
Tests commit at every numbered boundary and assert that each revision appears
once after the declared welcome head.

### Commands and acknowledgements

Commands carry `command_id`, name, and payload. The server returns terminal
acknowledgements only from authoritative receipts:

- `committed(command_id, revision)`;
- `duplicate(command_id, original_revision)`;
- `rejected(command_id, stable_reason)`.

Infrastructure uncertainty does not use `rejected`. The connection closes with
a retryable service signal or returns a non-terminal protocol error containing
the command ID. The client keeps the command pending and retries unchanged.

Initial stable rejection reasons are an exhaustive generated union:
`invalid_command`, `invalid_transition`, `not_participant`, `no_change`,
`session_ended`, `command_id_conflict`, `command_clock_skew`, and
`command_expired`. Retryable errors
are a separate frame with `command_id`, `code`, and optional `retry_after_ms`;
the initial codes are `authority_unavailable`, `stateholder_unavailable`,
`commit_uncertain`, `server_draining`, `recovery_overloaded`, and
`session_capacity`, and `session_overloaded`.

### Events

Client-command events include `command_id`. All events include `event_id`,
`base_revision`, and `revision`. Clients apply an event only when it is the exact
next transition. A duplicate is ignored; a gap, conflicting revision, unknown
required event, or invalid transition suspends live application and starts
recovery.

### Compatibility

The existing v1 contract remains sourced from `contract/schema/sync-v1.json`.
Corrected protocol changes originate in a new versioned schema, regenerate every
target, and pass drift checks. The server never silently serves incompatible
semantics under an existing version.

The corrected protocol is `sync-v2`; v1 remains frozen. The v2 schema adds:

- verified `session_id` and `participant_session_id` claim requirements;
- UUIDv7 command IDs and the 24-hour command window;
- `{revision, state_digest, chain_digest}` cursors;
- `snapshot`, `replay`, and `up_to_date` welcome variants;
- `event_id`, `command_id | cause_id`, `previous_chain_digest`, `chain_digest`,
  and `state_digest` on events;
- exhaustive terminal rejection and retryable-error frames;
- explicit participant leave and Session-end lifecycle commands/events.

`contract/schema/sync-v2.json` is the source. Golden wire fixtures live under
`contract/schema/fixtures/sync-v2/` and are decoded and re-encoded by both
Elixir and TypeScript. A v1 socket can connect only while the compatibility
server is explicitly enabled; it cannot enter v2 Sessions. The API/token owner
is `apps/api`. Phase 0 adds
`POST /v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/join` on top
of `mediaplane.Service.CreateJoin`. Its response contains the provider join
payload plus `sync: {url, token, protocol}`. The signed sync token contains
`tenant_id`, `room_id`, `session_id`, `participant_session_id`,
`participant_session_generation`, `session_generation`, protocol version,
issued-at, and expiry. The participant-session generation is created and stored
transactionally with the join decision. An ended or ending Session returns a
stable API conflict and no sync token. Checked-in redacted response/token
fixtures under `apps/api/internal/mediaplane/testdata/sync_v2/` are decoded by
`ChalkSync.Auth.TokenVerifier` contract tests. Phase 0 also inventories the
supported v1 client window.

The current contract-codegen loaders and emitters are v1-specific. Before any
v2 generated file is accepted, Phase 0 parameterizes
`tools/contract-codegen/src/emitters/sync-contract.mjs`,
`sync-elixir.mjs`, and `sync-typescript.mjs` for explicit v1 and v2 modes. V1
goldens must remain byte-for-byte stable. V2 emitters cover digest cursors,
welcome variants, correlated events, receipt unions, lifecycle frames, and
retryable errors. Generator tests and `scripts/codegen/` commands exercise both
versions and write separate generated outputs; a missing or unsupported version
fails rather than falling back to v1.

## Primary workflows

### First join

1. The socket verifies claims and derives the Session and participant-session
   keys.
2. The node registers the local subscription and ensures an authority exists.
3. The authority admits or restores the participant-session control projection.
4. The server creates a gap-free welcome cut and sends a complete snapshot.
5. Live events begin strictly after the snapshot revision.

Participant admission and participant connection presence are different facts.
Losing a socket does not immediately delete durable participant-session control
state.

### Command commit

1. The client applies an optional optimistic overlay and stores the command in
   its pending queue.
2. The receiving node routes the command to the fenced writer.
3. The writer checks its hot cache, then the authoritative receipt.
4. The writer validates against its current projection.
5. The Stateholder atomically records the receipt and, when committed, the event,
   next snapshot, and next revision.
6. The Stateholder completes the durability barrier.
7. The writer advances its working copy from the durable event.
8. The writer publishes head advancement and returns the durable outcome.
9. The socket sends the acknowledgement. Event and acknowledgement may arrive
   in either order; both carry the same command ID and revision relationship.

### Terminal rejection

A deterministic business rejection is recorded against the revision used for
validation. It emits no event. If the revision changed before the rejection was
recorded, the writer reloads and revalidates instead of persisting a stale
decision.

### Lost acknowledgement

If the event and receipt committed but the writer, origin node, socket, or
network failed before the acknowledgement arrived, the retry resolves the
existing receipt and returns the original outcome. It cannot commit again or
turn into `no_change`.

### Reconnect

1. The client retains its last authoritative cursor and pending command IDs.
2. It reconnects with exponential backoff and jitter.
3. The server sends an exact replay, complete snapshot, or up-to-date response.
4. The client replaces or advances its canonical replica.
5. The client reapplies still-pending optimistic commands over canonical state.
6. It sends unresolved commands again with their original IDs.
7. Durable receipts resolve acknowledgement loss without duplicate effects.

### Gap during live delivery

The client or non-authority node stops applying live events at the first gap. It
requests the exact suffix from its last valid cursor. If the suffix is outside
retention or fails validation, it replaces state from a snapshot. It never skips
forward to the new revision.

### Slow subscriber

Outbound delivery is bounded by queued bytes, event count, and oldest-event age.
Defaults are one MiB, 256 pending control events, or five seconds. A subscriber
that crosses any bound is detached and closed with a documented overload
recovery signal. The writer remains responsive, and the client reconnects
through replay or snapshot.

### Writer or node loss

The old writer stops committing as soon as lease renewal is uncertain. Local
sockets close with a restart signal or route to the replacement authority. A new
writer acquires a higher fencing token, hydrates the snapshot and head, and
serves existing receipts. Recovery must not create an empty permanently running
writer.

### Stateholder unavailability

Readiness becomes false. New joins and terminal command acknowledgements stop.
No mutation proceeds from a local working copy. Existing clients receive a
retryable service signal and reconnect with backoff. Recovery begins only after
the Stateholder and authority boundary are healthy.

### Session end

The authority commits one terminal control event, rejects later commands with a
stable `session_ended` outcome, closes subscribers, releases authority, and
starts the retention clock. A repeated Session-end cause first returns its own
individual cause receipt. Only a cause key with no receipt consults the original
lifecycle-intent index.
Session end uses a control-plane-issued server-cause key. Admission,
control-plane removal, and reconnect-grace expiry also have unique server-cause
keys and durable cause receipts, so authority loss cannot repeat lifecycle
events. Explicit client leave remains a command and never enters this workflow.

## Participant and connection lifecycle

Durable participant-session control and volatile connection presence must be
separate streams.

- A participant session may own multiple WebSocket subscriptions.
- Closing one subscription cannot remove the participant while another remains.
- Temporary socket loss enters reconnect grace instead of immediately emitting
  a durable participant-left event.
- Explicit leave, removal, or Session end changes durable control membership.
- Volatile online/offline presence is derived from cluster-wide connections and
  TTL/heartbeat state when that stream is implemented.
- Writer idle shutdown occurs after zero subscribers and no queued work. An
  abnormal writer exit does not create an empty transient restart loop.

The initial reconnect grace is 30 seconds and is configurable between 5 and
120 seconds. The participant-session generation from the join token identifies
one admission lifecycle. Explicit leave or removal bypasses grace. The API owns
Session status and the non-reusable Session generation; sync owns ordered
control events after admission. Volatile online/offline presence remains
outside this protocol version.

API-driven removal and Session end use a transactional outbox. One Postgres
transaction writes the lifecycle intent, cause ID, issuance generation, and
outbox row and moves the resource to `removing` or `ending`, which blocks new
tokens. The dispatcher delivers the cause to sync at least once. Sync orders it,
persists the cause receipt, and returns the durable result. The API resolves the
receipt and only then marks the resource `removed` or `ended`. Delivery or final
status failure is retried with the same cause key. Sync treats `ending` as an
admission block while commands ordered before the end cause retain their
authoritative order. The outbox cannot be acknowledged from a transport result;
it requires the durable sync cause receipt.

The durable `lifecycle_intent_id` survives individual cause expiry. When an
outbox delivery window expires, one API transaction issues a higher delivery
generation and fresh cause ID for the same intent. Every cause carries the stable
intent ID. Sync first returns any existing receipt for that cause key. For a new
cause key, it atomically resolves or creates the intent index as part of the
cause-key decision. A reissued intent that already committed resolves to the
original lifecycle revision and emits no event; one that never committed may be
ordered once. Retrying an earlier expired cause continues to return that cause's
stored rejection.

One delivery window is 24 hours. The API permits at most three windows, alerts
after the second, and after 72 hours moves the resource to terminal
`lifecycle_sync_failed`, permanently blocks new tokens, and stops reissuing. Sync
retains the compact intent index for seven days after API finalization or failure
confirmation. Operator recovery must resolve that stable intent before creating
any new intent; if safe resolution is unavailable after retention, the Session
stays terminal and its generation is never reused. Campaigns hold sync
unavailable past each boundary and prove bounded records, a final API state, and
at most one lifecycle event.

Join admission uses the signed participant-session generation as its cause key.
Explicit client leave remains a participant command and uses its original
command key and receipt; it never converts into a server cause. Reconnect-grace
expiry uses the participant-session generation plus a monotonic grace epoch.
Re-admission creates a higher participant-session generation, so a delayed cause
for an older generation is rejected without an event even after the full receipt
compacts.

## TypeScript client runtime

The client package is the source of truth for product sync behavior. Demo apps
remain thin.

The runtime must provide:

- WebSocket connection and protocol-version negotiation;
- schema validation through generated sync types;
- a canonical control replica and authoritative revision;
- a separate ordered pending-command overlay;
- one command ID per user intent, preserved across transport retries;
- exact event application, duplicate classification, and gap recovery;
- snapshot replacement and exact replay;
- acknowledgement/event correlation in either arrival order;
- stable handling of terminal rejection and retryable uncertainty;
- reconnect backoff with jitter and a bounded retry policy;
- observable connection, recovery, pending-command, and last-revision state;
- sanitized diagnostics suitable for browser, React, React Native, and support
  surfaces.

The public owner is `sdks/typescript/client/src/sync/SyncClient.ts`, exported as
`SyncClient`. It accepts an injected WebSocket factory and
`PendingCommandStore`. Browser builds provide an IndexedDB store; React Native
provides an AsyncStorage adapter; tests use an in-memory store. A sent command
with unknown outcome is persisted before transmission and is never evicted.
The default capacity is 128 unresolved commands; capacity rejects a new intent
before transmission and surfaces `pending_capacity_exceeded`.

Reconnect uses full jitter starting at 250 ms and capped at 30 seconds. It
continues while a sent command is inside the 24-hour supported window. At window
expiry the promise and diagnostics surface `outcome_unresolved`; the SDK never
reports success or rejection. Hosts can explicitly export unresolved command
records for support. Browser and React Native integration suites must terminate
and recreate the runtime between send and acknowledgement to prove persistence.

Expiry transactionally removes the command from the active pending set, removes
its optimistic overlay, and writes a payload-free archive record containing the
command ID, fingerprint, timestamps, and `outcome_unresolved`. The archive is a
1,024-record or 30-day ring, whichever limit is reached first, and remains
exportable. Expiry therefore frees active capacity without erasing the fact that
the outcome was unknown. A late frame for an archived ID is diagnostic evidence
and cannot silently change application state; the client recovers from an
authoritative snapshot.

Receiving `committed` is not enough to reveal a lower authoritative revision as
final state. The optimistic overlay remains until the corresponding event is
observed or a snapshot at or beyond the committed revision proves the effect is
present. Rejection removes or rolls back the overlay explicitly.

## Retention and cleanup

The current snapshot is retained for the active Session. The replay tail retains
the newest 50,000 events and at least one hour of events, subject to a hard
256 MiB compressed-data ceiling per Session. Checkpoint snapshots are produced
at least every 1,000 events. Compaction publishes an explicit replay floor;
older cursors receive a snapshot.

A checkpoint atomically stores `{revision, snapshot, state_digest,
chain_digest}` and sets `replay_floor` to that revision only after its durability
barrier. The first retained event is `replay_floor + 1` and its
`previous_chain_digest` equals the checkpoint chain digest. A cursor below the
floor receives the current complete snapshot. A cursor at the floor receives a
suffix only when both checkpoint digests match; a cursor above the floor
receives an exact suffix only when its retained event digests match. Compaction
conformance reconnects at every cursor class before, at, and after the floor and
proves either exact-chain replay or complete snapshot equivalence.

Command receipts are retained through
`command_timestamp + 24 hours + 5 minutes`, strictly beyond the last admissible
instant including future-clock skew. Server-cause receipts or compact cause
tombstones remain through `cause_expires_at + 5 minutes`. Terminal participant
and Session generation tombstones remain through the longest token, reconnect,
cause-delivery, and retry lifetime. These records are independent of event
compaction.
Lifecycle-intent indexes remain for seven days after API finalization or
`lifecycle_sync_failed` confirmation and are capped by the authoritative receipt
quotas below.
Deployments may raise these limits but cannot remove hard count and byte quotas.
The authoritative receipt plus lifecycle-index quota is 2,000,000 records or
512 MiB per Session and 10,000,000 records or 4 GiB per tenant, whichever limit
is reached first. Participant commands may consume at most 1,900,000 records or
480 MiB per Session and 9,000,000 records or 3.5 GiB per tenant. The remainder
is a separate lifecycle reserve that participant commands cannot consume.

Within each Session lifecycle reserve, the final 1,600 records or 16 MiB is
exclusive to control-plane removal and Session end. Within the tenant lifecycle
reserve, the final 10,000 records or 32 MiB is exclusive to Session end. Because
one intent may temporarily retain an expired cause receipt beside a fresh cause
receipt, every admission, removal, or end intent is charged for two cause
receipts plus one intent-index record. Five hundred participant removals plus one
Session end therefore require at most 1,503 records, leaving 97 records as
critical headroom.

Every lifecycle admission, removal, or end receipt and intent-index record is
payload-free and charged as eight KiB against the byte quota even when smaller.
The schema and launch proof cap and measure worst-case Redis `MEMORY USAGE`,
including the key, value, metadata, and allocator overhead, at eight KiB per
record. A record shape that exceeds that bound is rejected before launch. The
Session requirement therefore charges at most 12,312,576 bytes, below the
16-MiB reserve.

Quota accounting reserves three records and 24 KiB for every lifecycle intent
from its first cause until its intent index expires, even when fewer records
currently exist or the API has finalized it. A lifecycle cause without an
explicit intent ID is its own quota intent. The charge therefore cannot fall
while a delayed reissue could still add a receipt. `accounted_session_critical`
is the sum for retained removal and end intents in one Session;
`accounted_tenant_lifecycle` is the sum for every retained admission, removal,
and end intent in a tenant; and `accounted_tenant_end` is its Session-end subset.

Participant admission requires
`accounted_session_critical + 3 * (active_participant_sessions + 1) + 3` to fit
both Session critical-reserve limits; the final three records preserve the
Session-end path.

The same transaction checks tenant-wide capacity. Participant admission requires
the following charge to fit both full tenant lifecycle-reserve limits:

```text
accounted_tenant_lifecycle
  + 3                         # incoming admission intent
  + 3 * (tenant_active_participant_sessions + 1)
  + 3 * active_sessions
```

Session admission uses:

```text
accounted_tenant_lifecycle
  + 3                         # incoming Session-admission intent
  + 3 * tenant_active_participant_sessions
  + 3 * (active_sessions + 1)
```

Both count and eight-KiB byte charges are checked atomically with admission.

Tenant Session admission is also capped at 1,000 active Sessions and requires
`accounted_tenant_end + 3 * (active_sessions + 1)` to fit both exclusive tenant
terminal-reserve limits. At 1,000 active Sessions the protected future end
charge is at most 3,000 records and 24,576,000 bytes. Ending participants or
Sessions converts protected future charge into accounted intent charge without
increasing the equation, so seven-day churn cannot consume capacity needed by
currently active work. The 500-participant and 1,000-Session limits are
independent maxima, not a promise that every maximum can coexist under one
tenant quota. Admission that would cross any equation returns retryable
`tenant_capacity`. At
90 percent of a participant ceiling the Session rejects new participant commands
with retryable `session_capacity`. At 90 percent of the noncritical lifecycle
reserve it rejects new admissions and grace-expiry work while preserving
removal/end capacity. It never evicts an unexpired receipt or crosses any hard
quota. At the hard event ceiling the adapter compacts to a checkpoint before
admitting more work or fails closed. Production may lower these quotas only when
the proportional removal/end reserve remains sufficient; raising them requires
the resource-change proof defined below.

Snapshot fallback is the required recovery path below the published replay
floor.

Cleanup must:

- remove the Session snapshot, event sequence, receipts, authority record, and
  indexes as one lifecycle;
- avoid deleting while an active lease, subscriber, or retry window remains;
- expose pending and failed cleanup metrics;
- remain idempotent under repeated end and cleanup requests;
- keep debug traces outside authoritative retention.

Session IDs and Session generations are never reused. Cleanup retains a compact
ended tombstone for seven days, which exceeds token and retry lifetimes. After
the tombstone expires, first-state creation requires a fresh signed admission
decision from the API; the API rejects an ended generation from Postgres. This
control-plane check occurs only on creation and never on the real-time command
path. Delayed joins and commands are tested before, during, and after cleanup.

No fixed FIFO may silently shorten command idempotency. A hot in-process cache
may be bounded because the Stateholder remains the fallback.

## Resource safety

Production limits are explicit configuration with safe defaults and metrics.

- one MiB, 256 queued events, or five seconds maximum queued-event age per
  subscriber;
- 128 active pending client commands and 1,024 archived unresolved records;
- at most 12 reconnect attempts per rolling minute, with jitter and a 30-second
  backoff cap;
- at most 4,096 local receipt entries and 2,048 local event entries per node;
- at most 10,000 retained diagnostic spans per node or five minutes of spans,
  with payload redaction;
- a 15-minute writer idle timeout after the last subscriber and the seven-day
  ended tombstone described above;
- a 64 KiB decoded control-frame limit and a 25 ms p99 decode-time ceiling on
  release hardware;
- at most 256 events or one MiB per replay page, followed by continuation or
  snapshot fallback;
- at most 500 participant sessions, three subscriptions per participant
  session, and 1,000 subscriptions per Session;
- 256 queued commands or one MiB per Session writer, 1,024 forwarded commands
  or four MiB per node, and 64 coalesced/system messages per writer BEAM mailbox;
- no tenant, Session, participant, or command IDs as unbounded metric labels.

Production configuration may lower these defaults. Raising one requires an
explicit specification change, a memory-budget calculation, slow-consumer proof,
and release-load evidence; it cannot be changed through an unchecked environment
variable.

Exceeding a limit produces a documented rejection, disconnect, continuation, or
snapshot path. It cannot silently drop authoritative state.

`ChalkSync.Sessions.CommandAdmission` rejects before any request enters a shared
process mailbox. Each socket permits one admission attempt at a time and pauses
WebSocket read demand until that attempt resolves. Every local and remote
command uses one Redis script to reserve from the same Session-wide
256-command/one-MiB credit pool before ETS insertion or `:erpc`; a reservation
carries command key, bytes, and owner epoch. A pending reservation has a
five-second TTL. After ETS insertion, one Redis script atomically changes the
pending reservation to a non-expiring `enqueued` state. If that claim fails, the
endpoint removes the ETS entry before returning; the writer may process only
claimed entries. No origin can enqueue or forward without a reservation.

`ChalkSync.Sessions.CommandQueue` is a bounded ETS queue, not a GenServer
mailbox. The remote `:erpc` endpoint validates the reservation, inserts directly
into ETS, and emits one coalesced writer wake-up. `NodeRouter` is a stateless
module with no request mailbox. The writer pulls one command at a time, releases
the reservation after a Stateholder decision, and never receives command payloads
as process messages. Duplicate, expired, wrong-owner, and over-byte reservations
are rejected before insertion. Claimed credits cannot expire while their ETS
entries remain queued. On authority takeover, the new owner atomically reaps
claimed credits from older fenced epochs only after the old queue is unreachable;
an orphan ETS entry without a claimed credit is discarded and cannot execute.
Raw `GenServer.call`, `send`, and unreserved `:erpc` delivery to a writer are
forbidden.

At most 256 reserved command workers may exist cluster-wide for one Session and
1,024 per node. Load proof floods every socket and origin concurrently,
asserts no unreserved command is processed, and keeps writer/system mailboxes
below 64 coalesced or lifecycle messages while every ETS/credit boundary stays
within its count, byte, and TTL ceiling.

`ChalkSync.Transport.OutboundQueue` is the sole owner of queued frames for one
socket. Writers and fanout processes use a demand-aware enqueue call and never
send event payloads directly to a WebSock process mailbox. Only one encoded
frame may be handed to the transport at a time. Replay pages are at most 256
events or one MiB. Cross-node head hints are coalesced to one pending head per
Session. The acceptance test observes the outbound queue, WebSock mailbox,
fanout mailbox, replay buffer, process heap, and node memory while the peer stops
reading; every measured boundary must plateau and recover after disconnect.

## Operational contract

### Health and readiness

`/healthz` means the BEAM and HTTP listener are alive. `/readyz` means the node
can safely accept sync work.

Readiness requires:

- a production Stateholder adapter, never Memory;
- Stateholder command and head-read success within the readiness budget;
- authority acquisition/renewal capability;
- change-notification or head-reconciliation capability;
- valid production configuration;
- an enabled topology write gate with exactly two directly verified
  promotion-eligible replicas;
- the separately supplied production token-verifier dependency;
- no active drain state.

Readiness returns a machine-readable failing component without exposing secret
or customer data.

`/readyz` returns `200 {"status":"ready"}` or
`503 {"status":"not_ready","components":[...]}`. Startup remains unready until
every required check passes. Runtime probes cover every configured Redis shard
with disposable, versioned synthetic keys and remove them after the barrier
test. Readiness is a coarse admission signal; each real operation repeats its
own authority and durability checks and fails closed independently.

### Graceful shutdown

On termination the node becomes unready, stops accepting new upgrades and
commands, lets bounded in-flight Stateholder operations resolve, relinquishes or
expires writer leases, and closes remaining sockets with a reconnect signal.
No shutdown path acknowledges an uncommitted command.

The drain state machine is `ready -> draining -> stopped`. Entering `draining`
must affect `/readyz` within 500 ms, reject new upgrades with HTTP 503, return
retryable `server_draining` for commands that have not entered Stateholder, wait
at most one Stateholder deadline for in-flight decisions, and close sockets with
WebSocket code 1012. A SIGTERM integration test proves lease handoff and command
resolution through the replacement node.

### Required telemetry

Metrics and structured events cover:

- command count, terminal outcome, end-to-end latency, and ambiguous resolution;
- receipt hit, command-ID conflict, and receipt age;
- Stateholder latency, timeout, error, persistence, and failover;
- revision conflict, gap, corrupt event, and snapshot mismatch;
- writer start, stop, lease renewal, fencing rejection, and handoff time;
- event-head lag, backfill length, replay length, snapshot fallback, and
  reconnect mode;
- subscriber queue bytes/events/age, overflow, and disconnect;
- active Sessions, writers, sockets, and subscriptions;
- process memory, mailbox length, scheduler utilization, and restart rate;
- liveness, readiness, drain, and cleanup failures.

Logs and traces include correlation IDs, protocol version, revision, node ID,
and failure class. Tokens, command payloads, participant display names, and raw
customer content are excluded. High-cardinality identities may appear only in
controlled structured diagnostics, never metric labels.

### Release artifact and CI

The sync server has a reproducible release/container artifact, production config
validation, an Elixir CI job, generated-contract drift checks, the focused sync
gate, and breaker smoke coverage. Production boot fails if Memory, dev tooling,
or incomplete required adapters are selected.

Every Stateholder aggregate and event carries `record_schema_version` and
`minimum_writer_version`. Authority acquisition fails when the node cannot read
the record or is older than the minimum writer. Fanout replaces its projection
from a snapshot on an unknown required event. Mixed-version release tests run
old and new writers and fanout nodes through acquisition, handoff,
forward-written records, and rollback. A forward release may raise the minimum
writer only after all old nodes drain.

## Performance and recovery budgets

Correctness gates every performance result.

- control command acknowledgement: less than 100 ms p95 in-region under the
  release baseline;
- node-to-client committed event propagation: less than 100 ms p95 in-region;
- writer handoff after owner loss: less than 5 seconds p95;
- client convergence after node loss: less than 7.5 seconds p95, including
  reconnect backoff;
- readiness failure after Stateholder loss: less than 2 seconds;
- no sustained mailbox or heap growth after load returns to baseline.

The minimum release load baseline is:

- two sync nodes and the production Redis topology;
- 10,000 concurrent WebSockets across the cluster;
- 1,000 active Sessions;
- up to 250 participants in one Session;
- 500 control commands per second across the cluster;
- 20 control commands per second in one hot Session;
- ten percent deliberately slow or non-reading clients during the dedicated
  slow-consumer profile.

The release profile runs for at least 60 minutes and retains at least 30 percent
CPU and memory headroom. The soak profile runs for eight hours with stable
memory, bounded queues, no unexplained restarts, no lost terminal outcomes, and
no convergence failures. A higher declared launch target raises these numbers;
it never lowers them without an explicit spec change and evidence.

## Failure matrix

| Failure                                 | Required server behavior                                              | Required client behavior                         |
| --------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------ |
| Writer dies before commit               | No event or receipt; replacement may retry validation                 | Retry same command ID                            |
| Writer dies after commit before ack     | Receipt, event, state, and revision survive                           | Retry same ID and receive original outcome       |
| Origin node dies after forwarding       | Authority may commit once; receipt remains queryable                  | Reconnect, recover, retry same ID                |
| Ack is dropped                          | No second effect                                                      | Resolve from event/snapshot or retry same ID     |
| Event notification is dropped           | Node detects head lag and backfills exact suffix                      | Detect any local gap and recover                 |
| Events are duplicated/reordered         | Replica never applies outside exact chain                             | Ignore exact duplicate; recover on gap/conflict  |
| Writer lease is lost                    | Old token is fenced before mutation                                   | Reconnect or await routed replacement            |
| Two nodes claim authority               | Only the latest acquired token with an unexpired lease can commit     | Observe one authoritative history                |
| Redis is unavailable                    | Node becomes unready; no terminal ack or local-only mutation          | Keep pending and retry with backoff              |
| Redis response times out                | Resolve receipt; otherwise return uncertainty, never rejection        | Retry same command ID                            |
| Durability barrier times out            | Suppress fanout/ack; resolve or prove absent after failover           | Keep pending and retry same ID                   |
| Redis primary fails after ack           | Acknowledged state and receipt recover under declared topology        | Reconnect without duplicated effect              |
| Older Redis backup is restored          | New authority epoch fences every pre-restore writer                   | Recover from snapshot without revision invention |
| Subscriber stops reading                | Only that subscriber is bounded and disconnected                      | Reconnect through replay/snapshot                |
| Cursor is missing/future/unavailable    | Send complete snapshot                                                | Replace canonical replica                        |
| Cursor revision matches, digest differs | Send complete snapshot and corruption telemetry                       | Replace canonical replica                        |
| Replay is corrupt or non-contiguous     | Stop replay and snapshot; emit invariant telemetry                    | Refuse partial application                       |
| Empty writer restarts                   | Process exits and stays absent until demanded                         | No visible effect                                |
| Rolling deploy drains a node            | Node becomes unready, transfers/expires authority, closes cleanly     | Reconnect with compatible protocol               |
| Session ends during a pending command   | One terminal order decides commit or stable `session_ended` rejection | Reconcile from receipt/event                     |
| Delayed work arrives after cleanup      | Tombstone or API admission rejects the ended generation               | Surface stable Session-ended state               |
| Lifecycle cause expires in outbox       | Reissue the same intent generation and commit at most one event       | No direct client action                          |

## Testing and proof

### Unit and conformance tests

- pure reducer commands, semantic event validation, exact revision transitions,
  and complete snapshot parsing;
- shared Memory/Redis Stateholder conformance for receipts, atomicity, fencing,
  suffix reads, retention, cleanup, and failure errors;
- protocol generation and validation in Elixir and TypeScript;
- TypeScript replica, pending overlay, acknowledgement ordering, replay,
  snapshot, gap, retry, and diagnostics;
- writer and subscription lifecycle, multi-subscription behavior, and bounded
  outbound delivery.

### Breaker acceptance

The six current deterministic engine failures become passing engine assertions:

1. retry after writer restart returns the original outcome;
2. retry after more than 256 command IDs remains stable;
3. commit/ack interruption recovers the committed receipt;
4. revision-conflict recovery leaves no empty orphan writer;
5. a non-reading subscriber remains within the declared bound and is recovered;
6. the reducer explicitly rejects a non-contiguous revision.

Tests that currently expect a structured breaker failure are inverted. A green
ExUnit suite containing expected engine failures is not production evidence.

The existing passing boundaries remain mandatory:

- 100,000 independent model operations;
- real-wire concurrency, abrupt reconnect, and replica/stateholder comparison;
- writer restart with retries disabled;
- exact replay suffix and snapshot equivalence;
- snapshot fallback beyond event retention;
- multiple subscriptions for one participant session.

### Multi-node and Redis campaigns

At least two sync nodes serve connections for the same Session. Campaigns inject
concurrent commands, retries, owner loss before and after commit, origin-node
loss, lease expiry, stale owners, notification loss, delayed messages, Redis
timeouts, supported Redis failover, rolling drains, retention fallback, and slow
subscribers.

Redis campaigns run the checked-in baseline topology and every proposed launch
topology manifest. They inject sudden primary death, controlled promotion,
replica lag, partition from the write quorum, restart from AOF, failback, loss
between atomic mutation and `WAITAOF`, and fencing-record corruption. Passing a
single-node Redis fixture is never launch evidence.

The campaign continuously runs a pre-restore writer while it disables the gate,
isolates the target endpoint, restores an older coherent backup, rotates the
authority epoch, exposes the endpoint, and reenables the gate in the required
order. It attempts mutation and readiness after every step, including attempted
endpoint exposure before epoch rotation. Every forbidden-order attempt fails,
and every old-epoch commit is fenced.

The checker asserts continuously:

- one authoritative event order;
- model and replica convergence at equal revisions;
- acknowledgement/event correlation;
- rejected commands do not mutate;
- terminal outcomes remain stable;
- stale fencing tokens never commit;
- replay is the exact authoritative suffix;
- snapshots equal the authoritative fold;
- revisions never regress;
- queue, mailbox, process, and retained-data bounds hold.

### CI profiles

- Pull request: sync gate, Stateholder conformance, TypeScript client tests,
  generated drift, 32 model seeds, 16 real-wire seeds, and focused failure
  matrix.
- Nightly: 1,000 model seeds, 250 real-wire seeds, 100 multi-node Redis seeds,
  randomized restarts/retries, and resource assertions.
- Release: complete monorepo gate, 60-minute load profile, eight-hour soak,
  Redis failover, rolling-node drain, and saved machine-readable breaker reports.

Every failure records the seed, source revision, protocol version, commit SHA,
materialized operations, fault schedule, complete normalized trace, and a
failure-first Markdown report. A release report containing any harness error or
invariant failure blocks release.

Canonical commands and outputs are:

| Profile       | Command                                   | Maximum duration | Evidence                               |
| ------------- | ----------------------------------------- | ---------------- | -------------------------------------- |
| Focused       | `apps/sync/scripts/gate.sh`               | 10 minutes       | console plus JUnit                     |
| Breaker smoke | `apps/sync/scripts/breaker.sh smoke`      | 10 minutes       | `.artifacts/sync/<commit>/smoke/`      |
| Multi-node    | `apps/sync/scripts/breaker.sh multi-node` | 30 minutes       | `.artifacts/sync/<commit>/multi-node/` |
| Nightly       | `apps/sync/scripts/breaker.sh nightly`    | 2 hours          | `.artifacts/sync/<commit>/nightly/`    |
| Load          | `apps/sync/scripts/load.sh release`       | 90 minutes       | `.artifacts/sync/<commit>/load/`       |
| Soak          | `apps/sync/scripts/soak.sh release`       | 9 hours          | `.artifacts/sync/<commit>/soak/`       |
| Release proof | `apps/sync/scripts/release-proof.sh`      | 12 hours         | `.artifacts/sync/<commit>/release/`    |

The scripts create the Redis/Sentinel and named-BEAM topology through OrbStack,
build a uniquely tagged release artifact, enforce timeouts, and always write
`summary.json`, `report.md`, normalized traces, resource samples, and the
topology manifest. Raw artifacts stay ignored under `.artifacts/`; the final
redacted release summary is copied to `scratchpad/` when it is safe for the
public repo.

Phase 3 owns the topology manifests and `breaker.sh`; Phase 4 owns `load.sh`,
`soak.sh`, `release-proof.sh`, report writers, and CI wiring. These are tracked
repository deliverables. The relevant phase exit and every later profile fail
immediately when a declared script, topology file, result field, or report is
missing. None is an external prerequisite.

“Stable memory” means the final 30-minute linear-regression slope is within one
percent of allocated memory per hour after warm-up. Headroom is measured against
configured container CPU and memory limits. Any unexpected process restart,
unresolved command, invariant failure, harness error, or missing sample fails
the profile.

## Implementation ownership map

| Concern                                | Primary repository surface                                                                 | Required proof                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| v2 protocol and golden frames          | `contract/schema/sync-v2.json`, `contract/schema/fixtures/sync-v2/`, contract generators   | Elixir and TypeScript golden round trips plus drift check                        |
| Join identity and lifecycle generation | `apps/api/internal/mediaplane/`, API join response contract                                | API fixtures decoded by sync claim tests; ended-generation rejection             |
| Claims and protocol phases             | `apps/sync/lib/chalk_sync/auth/claims.ex`, `protocol.ex`, `transport/socket.ex`            | real-wire v1/v2 negotiation and identity-isolation tests                         |
| Session reducer and writer             | rename `rooms/room.ex` and `room_server.ex` under `ChalkSync.Sessions`                     | reducer conformance and six fixed breaker regressions                            |
| Stateholder port and Memory            | `apps/sync/lib/chalk_sync/stateholder.ex`, `stateholder/memory.ex`                         | shared adapter conformance suite                                                 |
| Redis durability                       | new `stateholder/redis.ex` and versioned server-side scripts under `apps/sync/priv/redis/` | baseline topology atomicity, barrier, recovery, and corruption campaigns         |
| Cluster routing and fanout             | new `cluster/node_router.ex`, `sessions/fanout.ex`, release node discovery config          | named two-node forwarding, partition, stale-owner, and gap-free-cut tests        |
| Bounded socket delivery                | new `transport/outbound_queue.ex`, existing router/socket                                  | non-reading peer resource plateau and recovery proof                             |
| TypeScript replica                     | new `sdks/typescript/client/src/sync/` exported by `src/index.ts`                          | unit, browser, React Native adapter, process-restart, and Elixir real-wire tests |
| Operations and artifact                | `application.ex`, `transport/router.ex`, runtime config, `apps/sync/scripts/`              | production-equivalent boot, readiness, SIGTERM drain, load, and soak             |
| CI                                     | repository workflows plus `pnpm run gate`                                                  | PR smoke, nightly, and release profiles with retained summaries                  |

The rename from `Rooms` to `Sessions` is a scoped semantic migration in the sync
app, including tests and supervisors. It does not rename the product Room model
or unrelated API/SDK surfaces.

## Implementation phases

### Phase 0 — Correct identity and contract

- change sync authority from Room to `{tenant_id, session_id}`;
- add `session_id` and `participant_session_id` to verified claims;
- add event ID and command correlation to the schema;
- define terminal versus retryable outcomes;
- regenerate Elixir and TypeScript outputs;
- add contract drift and identity-isolation tests;
- update the `apps/api` join-token issuer and fixtures for Session and
  participant-session identity;
- publish v2 golden frames, fingerprint vectors, rejection enums, and the
  v1-to-v2 support inventory.

Exit: two Sessions in one Room and identical IDs in two tenants remain fully
isolated in contract, Stateholder keys, writers, events, and receipts. The API
join endpoint issues a redacted fixture that sync verifies, ended Sessions issue
no token, v1 generated goldens remain unchanged, and v2 codegen plus golden wire,
fingerprint, digest, and UUID boundary vectors pass in Elixir and TypeScript.

### Phase 1 — Repair single-node correctness

- redesign the Stateholder port around atomic command decisions and receipts;
- update Memory to one atomic record boundary;
- enforce exact and semantically valid event transitions;
- remove the 256-entry receipt cache as an authority;
- recover committed and rejected outcomes after writer restart;
- separate transient uncertainty from terminal rejection;
- fix empty-writer lifecycle.

Exit: the revision, restart, eviction, commit-ambiguity, and orphan-writer
breaker scenarios pass against Memory.

### Phase 2 — Bound delivery and complete the client

- introduce bounded per-subscriber outbound delivery and overflow recovery;
- preserve multiple subscriptions and reconnect grace;
- implement the TypeScript transport, canonical replica, pending overlay,
  acknowledgement reconciliation, and reconnect loop;
- run the real TypeScript client against the Elixir server.

Exit: slow-subscriber and end-to-end SDK recovery scenarios pass with bounded
resources and no app-owned sync logic.

### Phase 3 — Add Redis and fenced multi-node authority

- implement Redis Stateholder conformance;
- add writer lease, renewal, fencing, takeover, and command routing;
- add cross-node head notification, exact backfill, and local fanout;
- reject Memory in production;
- add real Redis and two-node breaker profiles;
- implement `Redix`, `libcluster`, `NodeRouter`, server-time leases, the
  mutation/durability split, and record-version compatibility.

Exit: multi-node commands, owner/origin loss, stale-writer partitions,
notification loss, and supported Redis failover preserve one history and every
terminal outcome.

### Phase 4 — Production operations

- add dependency-aware readiness, graceful drain, and startup validation;
- add metrics, structured telemetry, diagnostics, and resource alerts;
- create the release/container artifact and Elixir CI job;
- add load, soak, and release-report automation.

Exit: the release artifact boots in a production-equivalent local topology,
passes readiness and drain checks, and produces complete operational evidence.

### Phase 5 — Release proof

- run the complete breaker, multi-node, load, soak, and failover gates;
- verify protocol compatibility and generated-client consumption;
- drain old Memory-backed development rooms rather than pretending they can be
  migrated as authoritative production state;
- produce the uniquely identified release artifact and complete evidence map.

Exit: every definition-of-done item below has direct observed evidence.

## Release compatibility and external rollout

Live rollout is outside this implementation specification. The following
compatibility contract is an external launch prerequisite and later belongs in
an environment-specific runbook approved in the active thread.

Redis keys are namespaced and schema-versioned. New Sessions start on the new
authority model; old development-only Memory Sessions are allowed to drain or
are explicitly discarded. There is no silent conversion of volatile ETS state
into claimed durable production history.

Server and SDK rollout order follows protocol compatibility:

1. deploy a server that understands old and new supported client versions;
2. release the new client runtime;
3. observe adoption and invariant telemetry;
4. remove an old protocol only after its support window ends.

Rollback may return to a server version only when it understands every record
and protocol version written by the forward release. A rollback that would
discard receipts, fencing state, or revisions is forbidden. When compatibility
cannot be guaranteed, forward-fix while keeping the server unready for new work.

The release proof writes v2 receipts, fencing state, events, snapshots, and
tombstones, then boots the previous compatible artifact against them. It also
hands authority between old and new nodes in both directions. The generated
compatibility matrix names readable/writable record versions and protocol
versions for each artifact. A missing downgrade proof marks rollback unsafe.

No production action is authorized by this specification. Deployment requires
the exact environment and deployment ID to be confirmed in the active thread.

## Definition of done

The sync server is done against this specification only when all statements are
true:

- live authority is tenant- and Session-scoped;
- Memory is dev/test-only and Redis passes the shared Stateholder contract;
- every acknowledged command has one durable, recoverable receipt;
- every exposed receipt and event has crossed the supported Redis durability
  barrier;
- retries after restart, eviction pressure, acknowledgement loss, node loss,
  and Redis failover preserve the original outcome;
- command ID reuse with different intent is rejected without mutation;
- one fenced writer produces one contiguous authoritative history;
- the reducer rejects revision gaps and invalid transitions explicitly;
- every committed command correlates to exactly one event;
- replay is an exact suffix and snapshots equal the authoritative fold;
- same-revision digest corruption forces snapshot replacement;
- welcome and live fanout have a gap-free cut;
- TypeScript clients converge through event/ack reordering, reconnect, replay,
  snapshot, and retry;
- slow clients, mailboxes, caches, traces, event tails, receipts, and Session
  data remain within declared bounds;
- writer, node, Stateholder, notification, and rolling-deploy failures satisfy
  the failure matrix;
- liveness, readiness, graceful drain, telemetry, and cleanup work in the
  release artifact;
- control latency, handoff, recovery, load, and soak budgets pass with measured
  headroom;
- all focused breaker scenarios pass as engine assertions;
- the sync gate, generated drift checks, TypeScript client gate, Elixir CI, and
  canonical monorepo gate are green;
- the release report contains zero invariant failures and zero harness errors;
- separate production launch prerequisites outside this specification are
  complete.

Anything less is not production-ready. A green unit suite, a successful local
demo, final-state convergence without continuous checks, or a Redis adapter that
has not survived the declared failures is insufficient evidence.

## Execution guardrails

- Extend the current Stateholder, Room, RoomServer, transport, protocol, and SDK
  boundaries before introducing new parallel abstractions.
- Change the schema source first and regenerate; never hand-edit generated
  contract files.
- Keep the independent breaker model independent from production reducers.
- Never weaken, skip, or invert a failing invariant to obtain a green gate.
- Convert every fixed breaker reproduction into a passing permanent regression.
- Treat command receipts as authority and process caches as optimizations.
- Treat local Registry uniqueness as local only.
- Treat Redis notifications as hints and retained state as truth.
- Keep demo and app code thin; product sync behavior belongs in the SDK package.
- Reject implicit fallbacks in production configuration.
- Add bounded queues before adding load.
- Make transient uncertainty visible and retryable; never relabel it as a
  terminal business rejection.
- Preserve unrelated work in the shared repository and avoid repository-wide
  refactors while executing this spec.

## Traceability to confirmed failures

| Confirmed failure                       | Specification closure                        |
| --------------------------------------- | -------------------------------------------- |
| Outcomes lost after writer restart      | C3–C5, durable receipts, Phase 1             |
| Outcomes forgotten after 256 IDs        | C4, authoritative receipt retention, Phase 1 |
| Commit succeeds without recoverable ack | C3, C5, lost-ack workflow, Phase 1           |
| Conflict restart leaves empty writer    | C2, writer lifecycle, Phase 1                |
| Slow subscriber mailbox grows linearly  | C11, bounded delivery, Phase 2               |
| Reducer accepts revision jump           | C6, reducer conformance, Phase 1             |

## Acceptance evidence index

| Contract                                              | Owner                                          | Command or profile                     | Pass threshold                                                                                      |
| ----------------------------------------------------- | ---------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| C1 identity partitioning                              | API, protocol, Stateholder                     | focused gate                           | zero cross-tenant, cross-Session, or participant-session collisions                                 |
| C2 fencing and lease time                             | Redis adapter, SessionServer                   | multi-node plus release proof          | only latest acquired unexpired token commits; zero regression after every failover/failback case    |
| C3–C5 decisions, receipts, and honest acks            | Stateholder adapters, protocol                 | adapter conformance plus breaker smoke | one durable outcome per command key; zero fanout/terminal acks before barrier                       |
| C6–C8 reducer, event correlation, replay, and digests | reducer, contract generators                   | focused gate plus nightly model        | exact revision chain, one event per committed key, exact suffix, equal fold/digest for every seed   |
| C9 welcome cut                                        | fanout, transport                              | multi-node                             | commits at every handshake boundary produce no missing or repeated post-welcome revision            |
| C10 replica convergence                               | TypeScript SyncClient                          | real-wire nightly plus load            | every replica at equal revision has the authoritative digest                                        |
| C11 bounds                                            | outbound queue, client store, retention worker | slow-consumer load plus soak           | every declared count, byte, and age bound holds and memory slope passes                             |
| C12 acknowledged durability                           | Redis adapter and topology                     | release proof                          | zero lost acknowledged decisions across every supported storage failure                             |
| Failure matrix                                        | breaker harness owners                         | multi-node plus release proof          | every row has an injected trace and expected server/client outcome; no skipped row                  |
| Latency and recovery budgets                          | load harness                                   | load plus release proof                | every listed p95 and readiness deadline passes with at least 30 percent headroom                    |
| Operations and compatibility                          | release and config owners                      | release proof                          | boot, shard probes, SIGTERM drain, old/new handoff, downgrade-read test, and artifact identity pass |

The release summary links every row to its individual test result and trace. One
generic green job cannot satisfy a row whose fault or measurement did not run.

## Required evidence at handoff

The implementation handoff includes:

- the final language-neutral protocol and generated drift proof;
- Stateholder conformance results for Memory and Redis;
- focused breaker, model, real-wire, and multi-node reports;
- the exact seeds and traces for any fixed counterexamples;
- TypeScript client unit and real-server integration results;
- load, eight-hour soak, Redis failover, and rolling-drain reports;
- release artifact identity and production-equivalent boot/readiness proof;
- a binary readiness verdict listing any incomplete external launch prerequisite.
