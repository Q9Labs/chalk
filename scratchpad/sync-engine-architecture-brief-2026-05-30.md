# Chalk Sync Engine Architecture Brief

Date: 2026-05-30

Drafted with Gemini CLI using `gemini-3.1-pro-preview`, then lightly cleaned up
for Chalk terminology.

## The Core Sync Challenge

A robust realtime sync engine is more than pushing messages over WebSockets. It
is a versioned state machine with explicit rules for ownership, ordering,
idempotency, invalidation, replay, and snapshot fallback.

For every stream of meeting state, whether participant presence, room controls,
whiteboard scenes, chat, or transcripts, we need to define:

- What is the source of truth?
- What version identifies the current state?
- What does a client claim to have seen?
- What is the server's recovery contract when that claim is stale or wrong?

## Current Chalk Sync Risks

Chalk currently relies heavily on live-process reliability and snapshot healing.
That is a reasonable starting point, but it creates correctness and scaling
risks.

1. **Live-reliable is not durable.** In the current code, reliable delivery means
   we do not silently drop messages for a locally connected socket. But
   cross-node fanout uses Redis Pub/Sub. If a subscriber pauses, a process
   crashes, or a publish fails, those messages are not replayable.

2. **Snapshots are incomplete.** Clients reconnect by requesting a room
   snapshot, but important state is missing: raised hands, whiteboard
   permissions, whiteboard open state, and authoritative recording state. If a
   live event is missed, local state can diverge permanently.

3. **Cursors are ambiguous.** The current sync payload uses a timestamp-like
   marker instead of a monotonic event sequence. That prevents exact replay and
   makes it hard to prove whether a client is caught up.

4. **Cross-instance state can split.** Some domain services broadcast locally
   instead of through cross-instance fanout. Clients on different API instances
   may see different live states, and incomplete snapshots may not heal the
   difference.

5. **Whiteboard authorization is process-local.** Whiteboard permissions live in
   hub memory. One API instance can accept a command that another would reject.

## Lessons From Convex And Zero

Convex and Zero are different systems, but they share a few invariants that
Chalk should borrow.

- **Exact version chains.** Server transitions should include a starting
  revision and an ending revision. If a client has revision 41, it should reject
  an update that starts from revision 40 or 42. That is how the client detects
  dropped, duplicated, or out-of-order updates.

- **Declarative desired state.** Clients should say what they want before the
  server sends data. A mobile client may only need roster and chat. A web client
  with the whiteboard open needs the whiteboard stream too.

- **Read-your-writes consistency.** A command should not feel finished merely
  because a handler accepted it. For important commands, the client-side promise
  should resolve only after the authoritative sync stream advances past that
  command's committed revision.

- **Server-owned revisions.** Reconnect should work like a protocol restart.
  The client declares active streams and last observed revisions. The server
  decides whether to replay retained events or send a fresh snapshot.

## Recommended Architecture

Chalk should use a shared sync protocol core, with different durability rules
per stream.

- **Presence:** cursors, speaking indicators, typing, and similar state. This
  should remain volatile. No replay. State expires naturally.

- **Room control:** joins, leaves, roles, permissions, recording state, hand
  raise, room end. This should become durable-reliable with a per-room
  `control_revision`.

- **Whiteboard scene:** Excalidraw elements and clears. Keep snapshot-first
  recovery, but add server-owned `whiteboard_revision` plus the existing
  `sceneId` epoch. Cursors remain volatile.

- **Chat and transcripts:** Postgres is the source of truth. WebSocket should be
  notification and acceleration, not the durable source.

### 1. Add A Durable Room Event Log

Create an append-only per-room event log for critical room-control changes.
Postgres is the best first source because most authoritative state already
lives there. Redis can still accelerate fanout, but it should not be the only
place reliable events exist.

Each durable event should have a room ID, stream name, event ID, actor,
monotonic revision, timestamp, command ID when relevant, and payload.

### 2. Make Hubs Consumers

API hubs should stop being the source of truth. The new flow should be:

1. A command validates against authoritative state.
2. The command writes source-of-truth state and appends an event.
3. Hubs consume the event.
4. Hubs update local caches from the event.
5. Hubs broadcast to connected clients.

This makes every API instance converge through the same event stream.

### 3. Version Snapshots By Domain

Room snapshots should not expose one vague timestamp. They should carry domain
versions:

- `controlRevision`
- `whiteboard.sceneId`
- `whiteboard.revision`
- chat cursor or newest message revision
- transcript cursor or newest segment revision

Snapshots should also include the state needed to heal: participants, recording,
whiteboard permissions, raised hands, and room-ended state.

### 4. Make Reconnect Declarative

Replace blind `room.sync` with stream-specific reconnect state. The client sends
desired streams and cursors. The server handles each stream:

- If the cursor is valid and retained, replay missing events.
- If the cursor is missing, stale, or epoch-mismatched, send a snapshot.
- If the client claims a future cursor, reject it and force a snapshot.

### 5. Add Command IDs And ACKs

Important commands should have session-scoped command IDs. The server should
answer with one of: committed, duplicate, or rejected.

Optimistic UI can still update immediately, but internal state should resolve
only after the client observes the committed revision through the sync stream or
a snapshot.

## Phased Migration Plan

**Phase 0: Redefine The Contract**

Document the difference between volatile, live-reliable, and durable-reliable
streams. Stop treating timestamps as real sync cursors.

**Phase 1: Complete Snapshot Healing**

Add missing room state to snapshots: whiteboard permissions, raised hands,
authoritative recording state, and room-ended state. Ensure the SDK clears local
state when snapshots say that state is absent.

**Phase 2: Add Room-Control Revisions**

Create the durable event log/outbox. Assign monotonic `control_revision` values.
Move recording, permissions, hand raise/lower, participant updates, and room end
onto this path. Make hubs consume events before broadcasting.

**Phase 3: Replay On Reconnect**

Implement stream cursors. Replay retained events when possible, fall back to
snapshots when needed, and add client-side gap detection for exact-base
transitions.

**Phase 4: Whiteboard Revisions And ACKs**

Add `whiteboard_revision` and command ACKs for whiteboard updates and clears.
Keep snapshot-first recovery first; add short replay only after revisions are
stable.

**Phase 5: Chaos Testing**

Build a deterministic sync harness that drops, delays, duplicates, and reorders
messages, forces reconnects, and restarts server processes. Assert convergence,
no backwards revisions, no stale whiteboard epoch resurrection, and correct
command idempotency.

The target is not to copy Convex or Zero. The target is to adopt their core
discipline: exact versions, explicit client intent, durable command outcomes,
and reliable recovery when a client is wrong or behind.
