# Chalk Sync Engine Deep Dive

Date: 2026-05-30

This is a living architecture/research note for making Chalk's live meeting sync
engine more robust. It captures current findings from the Chalk codebase and
from local inspection of open-source sync engines, especially Convex and Zero.

The goal is not to copy either system. The goal is to extract the invariants
that make mature sync systems durable, then translate them into a Chalk-shaped
architecture for video meetings, room state, whiteboard collaboration, chat,
transcripts, and recovery after reconnects.

## Research Sources

Local research clones live outside the Chalk repo:

- Convex backend: `/tmp/chalk-sync-research/convex-backend`
  - Git HEAD inspected: `7eade4a8745e654b320170dd9c54f3edac051fca`
- Rocicorp monorepo, including Zero and Replicache: `/tmp/chalk-sync-research/rocicorp-mono`
  - Git HEAD inspected: `517f29f305aaf09326d8196d42f216b8dd393b3e`

Public docs used for orientation:

- Convex realtime docs: `https://docs.convex.dev/realtime`
- Zero sync docs: `https://zero.rocicorp.dev/docs/sync`
- Zero self-host architecture docs: `https://zero.rocicorp.dev/docs/self-host`

## Working Thesis

A serious sync engine is not "send messages over WebSocket." A serious sync
engine is a versioned state machine with explicit ownership, ordering,
idempotency, invalidation, replay, and snapshot fallback rules.

The main question for Chalk is:

> For each stream of meeting state, what is the source of truth, what version
> identifies it, what does a client claim to have seen, and what is the server's
> recovery contract when the claim is wrong or too old?

## Vocabulary

- **Stream**: A named state channel with its own ordering and durability rules.
  Examples: `presence`, `room.control`, `whiteboard.scene`, `chat`, `transcript`.
- **Revision**: A server-assigned monotonic position in a reliable stream.
- **Epoch**: A discontinuity marker. For whiteboard, Chalk already has
  `sceneId`; clear advances the epoch so stale deltas cannot resurrect content.
- **Snapshot**: A full materialized state at a known revision or epoch.
- **Replay**: Applying ordered retained events from a known revision to current.
- **Cursor**: A client claim about the newest revision it has fully applied.
- **Desired view**: The subset of state a client currently wants. Zero models
  this as desired queries; Chalk can model it as desired meeting streams/views.
- **Client view record**: Server knowledge of what a client or client group has.
  Zero's CVR is the mature version of this idea. Chalk likely needs a smaller
  in-memory view record first.

## Current Chalk Sync Shape

### WebSocket Reconnect

`packages/sdk-core/src/ws-client/base.ts` reconnects with backoff and requests a
fresh room snapshot after a successful reconnect:

- `base.ts:153` sends `room.sync` after reconnect.
- The payload uses `lastSeq: this.now()`, which acts more like a marker than a
  true stream cursor.

`apps/api/internal/interfaces/websocket/client.go` handles `room.sync` by
returning a reliable full room snapshot:

- `client.go:408` parses `RoomSyncPayload`.
- `client.go:412` calls `GetRoomSnapshot`.
- `client.go:415` sends the snapshot with `SendReliable`.

This is a snapshot-healing approach. It is simpler than replay, and that is not
bad, but the contract should be explicit: either `lastSeq` is a real retained
event cursor, or it should not pretend to be one.

### Live-Reliable vs Durable-Reliable

Chalk currently has a useful distinction between volatile sends and important
sends, but `SendReliable` is still live-process reliability, not sync-engine
durability:

- `client.go:53` gives each socket a buffered send channel of 256 messages.
- `client.go:111` `Send` drops when that buffer is full.
- `client.go:124` `SendReliable` enqueues or closes the slow client with a
  backpressure close. That prevents silent local divergence, which is good.
- `hub.go:413` `FanoutToRoomReliable` sends to local clients and publishes to
  Redis.
- `redis.go:53` uses Redis `PUBLISH`; `redis.go:58` uses `SUBSCRIBE`.

That means "reliable" currently means "do not silently drop for a connected
local socket." It does not mean "persisted, acknowledged, replayable, ordered
across API instances." Redis Pub/Sub is at-most-once. `publishToRedis` logs
errors at `hub.go:832` but there is no durable outbox or retry contract.

This distinction should become naming in the architecture:

- **volatile**: may drop with no recovery expectation.
- **live-reliable**: enqueue or disconnect; reconnect must heal from snapshot.
- **durable-reliable**: append to log, assign revision, deliver, ack/replay or
  snapshot if replay window is gone.

### Room Snapshot Completeness

`RoomSnapshotPayload` is intentionally small today:

- `messages.go:170` includes room ID, participants, recording status,
  recording ID, `last_seq`, and optional chat messages.
- It does not include raised hands, whiteboard permissions, whiteboard open
  state, moderation state, room-ended state, read receipts, transcript cursor,
  or whiteboard scene cursor.

That is fine only if those omitted fields are treated as transient. Some are
not transient from a meeting UX point of view:

- Hand raise/lower uses reliable fanout at `client.go:508`, but there is no
  authoritative raised-hand set in snapshots.
- Whiteboard permission grants/revokes mutate a process-local map at
  `whiteboard_permissions.go:83` and fan out `permission.changed` at
  `client.go:693`, but the permission map is not included in room snapshots.
- Whiteboard opened/closed events are reliable fanout notifications at
  `client.go:741`, but there is no server-owned open-participants set.
- Recording state is updated in DB/Redis/hub memory by the recording service,
  but `GetRoomSnapshot` reads only hub memory for recording state at
  `hub.go:644`; it does not hydrate `RoomState.GetRecordingState`.
- The SDK snapshot handler sets recording state when `snapshot.isRecording` is
  true at `ws-signaling.ts:228`, but the current handler does not explicitly
  clear a previously set recording when a later snapshot says false.

The rule should be: anything that must heal after reconnect belongs either in a
snapshot or in a retained replay stream. If it is in neither place, missed live
delivery can become permanent local truth.

### Cross-Instance Fanout

There are two fanout families today:

- `FanoutToRoomReliable` / `FanoutToRoomVolatile` broadcast locally and publish
  to Redis for other API instances.
- `BroadcastToRoom` is local-only because it delegates to
  `BroadcastToRoomReliable` at `hub.go:425`.

Several domain services use local-only `BroadcastToRoom`:

- Participant join/update/leave in `participant/service.go:594`,
  `participant/service.go:917`, and `participant/service.go:842`.
- Room end in `room/service.go:387`.
- Recording start/stop updates DB, Redis, and local hub memory in
  `recording/service.go:105` and `recording/service.go:145`, but does not send
  a room event or snapshot fanout.

This creates split-brain risk under horizontal scale: clients connected to the
same API instance see one thing live; clients on another instance may only heal
if a later snapshot contains the state, and some state is not in snapshots.

### Whiteboard Client Engine

`packages/chalk-whiteboard/src/collab/engine.ts` has several good primitives:

- `sceneId` is the whiteboard epoch.
- Local changes are debounced by 150 ms.
- A full sync is sent every 20 seconds after local deltas.
- The client sends per-sender `seq`.
- Remote updates with a mismatched `sceneId` are rejected unless they are an
  empty `syncAll` clear.
- `reconcileElements` and `restoreElements` delegate element merge semantics to
  Excalidraw.

The important code paths are:

- `flushNow` starts at `engine.ts:123`.
- Local clear advances epoch and requests a sync at `engine.ts:138`.
- Full sync scheduling starts at `engine.ts:179`.
- Remote reconciliation starts at `engine.ts:214`.

### Whiteboard Server State

`apps/api/internal/interfaces/websocket/whiteboard_state.go` keeps an in-memory
room whiteboard state and persists snapshots with debounce:

- `WhiteboardState` stores `SceneID`, element map, `UpdatedAtMs`, and `LastSeq`.
- `UpdateWhiteboardState` rejects stale epochs at `whiteboard_state.go:75`.
- Elements merge by Excalidraw `version`, with `versionNonce` tie-breaking.
- `ClearWhiteboardState` advances `SceneID` at `whiteboard_state.go:136`.
- `GetWhiteboardSnapshot` returns a stable ordered full snapshot.

Current concern: `LastSeq` is not a global server revision. It is advanced from
client-provided per-sender `seq`, so it is not a reliable room-level replay
cursor. That is acceptable if whiteboard recovery is defined as snapshot-only,
but dangerous if future code treats it as a durable event position.

Additional concerns from the current implementation:

- Accepted whiteboard state is persisted with a 750 ms debounce in
  `whiteboard_state_persist.go:18`; accepted updates can be lost if the process
  crashes before the timer fires.
- `Hub.Close` stops pending whiteboard persist timers at `hub.go:906` without
  flushing them.
- Whiteboard snapshots return `files` and `app_state` as `{}` in
  `whiteboard_state.go:200`, so image/file state is not part of the authoritative
  sync snapshot.
- Remote hubs that receive a Redis `permission.changed` message broadcast it to
  clients, but do not apply it to their own `whiteboardPermissions` map. Command
  validation can therefore diverge across API instances.

### Whiteboard SDK Manager

`packages/sdk-core/src/managers/whiteboard-manager.ts` tracks
`lastSeqByParticipant`, suppressing duplicate or older updates from the same
participant:

- Per-participant sequence check is at `whiteboard-manager.ts:136`.
- Snapshot clears this per-participant map at `whiteboard-manager.ts:169`.

This is useful idempotency at the client edge, but it is not global ordering.

### Durable Domains Already Present

Not everything needs a custom event log from scratch. Chalk already has durable
sources for several streams:

- Chat messages and read receipts are in Postgres. WebSocket should be treated
  as notification/acceleration; reconnect can fetch durable chat state.
- Recording rows are durable in Postgres, with Cloudflare as provider source.
- Room and participant history are durable in Postgres.
- Final transcript snippets are persisted in Postgres, but the current
  client-originated transcript ACK uses `Send`, not `SendReliable`, at
  `client.go:818`.

The sync-engine work should connect these durable sources to a consistent live
event/recovery protocol, not replace them wholesale.

### Current Risk Inventory

Highest-risk sync gaps, ordered by meeting UX impact:

1. **Room-control events have no monotonic revision.** `room.sync` ignores the
   provided cursor and `last_seq` is a timestamp, not an event sequence.
2. **Cross-instance delivery is inconsistent.** Some paths use Redis fanout;
   domain-service paths use local-only broadcast.
3. **Reliable Pub/Sub is not durable.** A Redis subscriber pause, process crash,
   or publish error can lose "reliable" messages.
4. **Snapshots are not complete enough to heal all reliable-looking events.**
   Permissions, hand raise, whiteboard-open state, room-ended state, and some
   recording transitions are outside the snapshot contract.
5. **Whiteboard command authorization is process-local.** Permission state can
   diverge across hubs, so the same participant may be accepted by one instance
   and rejected by another.
6. **Whiteboard persistence is debounced and compacted.** Good for cost, but
   not a durable acknowledgement boundary.
7. **Transcript dedupe is check-then-insert.** `external_id` has an index but
   not a uniqueness constraint in `006_transcription.sql:21`, so concurrent
   retries can duplicate final transcript snippets.

## Convex Findings

Convex is not a document-delta engine in the Zero sense. It is a synchronized
query-result engine. The key model is:

1. Queries execute against a transaction timestamp.
2. The database records the read set used by the query.
3. Writes append to a write log with increasing timestamps.
4. The subscription manager checks whether a write overlaps a query's read set.
5. If overlap exists, the query is invalidated and re-executed.
6. The client receives a transition from one state version to another.

Important inspected files:

- `crates/convex/src/base_client/mod.rs`
- `crates/convex/sync_types/src/types/mod.rs`
- `crates/database/src/token.rs`
- `crates/database/src/write_log.rs`
- `crates/database/src/subscription.rs`
- `crates/database/src/committer.rs`
- `crates/convex/src/sync/web_socket_manager.rs`

Notable invariants:

- `BaseConvexClient` is a sync state machine, not a WebSocket wrapper. Its docs
  say callers must flush outgoing messages after subscribe/unsubscribe/mutation
  and must call `resend_ongoing_queries_mutations` on reconnect.
- Client messages carry query-set versions. Server transition messages carry
  `start_version` and `end_version`.
- `ClientMessage::Connect` carries `connection_count`, `last_close_reason`, and
  `max_observed_timestamp`.
- `receive_message` observes transition timestamps and updates local query
  results only through server transitions.
- Write log retention matters. If a token's read set is too old for the retained
  write log, Convex cannot cheaply refresh it and must invalidate.
- Commits validate optimistic concurrency by checking read sets against both the
  committed write log and pending writes.

Deeper points from the Convex deep read:

- Transitions are an exact version chain. The browser client refuses a
  transition whose `startVersion` does not match local remote state; this is how
  missing, duplicated, or reordered transitions are detected early.
- Query-set changes include `baseVersion` and `newVersion`; the server rejects
  stale bases instead of trying to merge ambiguous subscription intent.
- Reconnect is a desired-state replay. The client drops remote query cache,
  sends `Connect`, resends auth, rebuilds the full active query set from
  `baseVersion: 0`, and restarts tracked requests.
- The server rejects reconnects from clients that claim to have observed a
  timestamp newer than the backend knows. That protects linearizability when a
  client bounces between backend instances.
- Mutations and actions are deliberately different. Successful mutations are
  idempotent and replayable; in-flight actions are failed locally on reconnect.
- Mutation promises resolve only after the client receives a transition at or
  past the mutation commit timestamp. Acceptance is not enough; read-your-writes
  requires the authoritative stream to advance.
- Server-side mutation idempotency is keyed by session and request ID, with the
  completion record written atomically with the mutation side effect.
- Subscription state is self-describing: if a query lacks a subscription or
  invalidation future, the worker knows what repair work remains.
- Read-set tokens are not just cache keys. They encode dependency ranges and a
  timestamp; refresh succeeds only if retained writes do not overlap those
  dependencies. Out-of-retention becomes a forced refetch, not silent reuse.

Translation for Chalk:

- For reliable Chalk streams, make revisions server-owned and explicit.
- Treat reconnect as a protocol restart: client declares current active views
  and last observed revisions; server chooses replay or snapshot.
- Use source-of-truth state transitions rather than assuming broadcast delivery
  equals convergence.
- For derived room views, consider a light "view token" model: a client depends
  on roster, permissions, recording state, active whiteboard epoch, etc.
- Resolve command promises only after the relevant authoritative stream revision
  is observed by the client. For example, `grantWhiteboardPermission` should
  resolve after the permission event/snapshot revision is applied, not merely
  after the HTTP/WS handler accepts the command.
- Use session-scoped command IDs and persist command completion records for
  idempotent commands such as chat send, read receipt, permission change,
  recording start/stop, hand raise/lower, and whiteboard mutation.
- Avoid running media packets, ICE, or stats through this engine. The sync
  engine is for authoritative meeting state, not the media plane.

## Zero Findings

Zero is closer to a local-first client-view sync engine. The mature idea to
borrow is not its exact Postgres machinery; it is the split between what the
client wants, what the server knows the client has, and what changed in between.

Important inspected files:

- `packages/zero-client/src/client/query-manager.ts`
- `packages/zero-client/src/client/mutation-tracker.ts`
- `packages/zero-client/src/client/ivm-branch.ts`
- `packages/zero-client/src/client/zero-poke-handler.ts`
- `packages/zero-protocol/src/connect.ts`
- `packages/zero-protocol/src/poke.ts`
- `packages/zero-cache/src/services/view-syncer/cvr.ts`
- `packages/zero-cache/src/services/view-syncer/cvr-store.ts`
- `packages/zero-cache/src/services/view-syncer/client-handler.ts`
- `packages/zero-cache/src/services/view-syncer/view-syncer.ts`
- `packages/zero-cache/src/services/change-streamer/change-streamer-service.ts`
- `packages/replicache/src/db/rebase.ts`

Notable invariants:

- `QueryManager` deduplicates desired queries and sends `changeDesiredQueries`
  patches.
- Query deregistration is delayed while mutations are pending because rebase may
  need data that was in scope when the mutation first ran.
- `initConnection` sends desired queries before server begins sending pokes, so
  the server does not waste work syncing views the client no longer wants.
- Pokes are multi-part transitions from `baseCookie` to `cookie`.
- The client rejects or reconnects on poke ordering/cookie gaps.
- CVR storage tracks clients, desired queries, gotten queries, row records,
  versions, owner, TTL, and replica version.
- CVR flush uses version and ownership checks to prevent concurrent modification.
- Change streaming uses watermarks carefully. The Zero comments explicitly warn
  that non-commit LSNs can interleave, so only commit watermarks should be used
  as externally meaningful stream positions.

Deeper points from the Zero deep read:

- Connection intent is explicit before data flows. The protocol waits for a
  connected handshake, then requires `initConnection` with desired queries; the
  client may put that in `Sec-WebSocket-Protocol` but falls back to a message if
  it is too large.
- Desired queries are persisted and diffed client-side. Query removals are
  delayed while mutations are pending because local rebase may need the data
  the mutation originally read.
- Server `initConnection` creates the downstream subscription and validates
  schema/auth under the view-syncer lock before releasing data.
- Pokes are atomic multipart transitions: `pokeStart(baseCookie)`, zero or more
  parts, then `pokeEnd(cookie)`. The client applies them under a lock and
  disconnects on base-cookie mismatch or cookie gaps.
- Replicache validates expected base cookie inside the write transaction before
  applying a poke or pull response. Response cookies and last mutation IDs
  cannot move backward.
- CVR is a durable client view record. It stores client group versions, desired
  queries, gotten queries, row records, tombstones/refcounts, ownership, TTL,
  replica version, and per-record patch versions.
- CVR writes are guarded by expected version and owner, so concurrent view
  syncers cannot both believe they own the same client view.
- Change streaming distinguishes externally meaningful commit watermarks from
  internal ordering positions. If upstream commit positions can overlap, only
  commit watermarks should be exposed as sync cursors.
- Mutation results are durable rows. They are poked down to the client, the
  client resolves/rejects promises, then sends an ack so the server can clean up
  observed results.

Translation for Chalk:

- Model client desired state explicitly. A mobile client in the roster view,
  web client with whiteboard open, and observer with transcript open do not need
  the same stream set.
- Track "what this connection has" at least in memory. Persisting it like a CVR
  is probably overkill initially, but the concept is valuable.
- Make a mismatch recoverable: if a client's base revision is too old, send a
  snapshot; if the client is somehow ahead, reject and force full resync.
- Separate mutation acknowledgment from visual update delivery. For whiteboard,
  this means local user feedback can be optimistic, but server acceptance should
  still produce an authoritative revision or rejection path.
- Treat every server push as an exact-base update. If the client has
  `controlRevision=41`, a push from `40 -> 42` should be rejected and trigger
  resync, not applied optimistically.
- Keep a small Chalk CVR only if it earns its keep. A useful V1 might track
  `connectionId`, desired streams, last sent revisions, active whiteboard scene,
  pending command IDs, auth version, and expiration. It does not need arbitrary
  query rows like Zero.
- Delay removal of stream/view state while optimistic local commands may still
  need it for rebase or command resolution.
- Do not expose raw database LSNs or provider offsets as app-level cursors.
  Expose committed Chalk revisions/watermarks.

## Proposed Chalk Stream Model

Chalk should not build one sync policy for every realtime thing. It should have
a small shared protocol core and stream-specific durability policies.

### `presence`

- Examples: cursors, speaking indicators, transient typing.
- Delivery: volatile.
- Source of truth: live participants and TTL.
- Recovery: no replay; state expires naturally.
- Version: optional local timestamp, not a durable revision.

### `room.control`

- Examples: participant joined/left, roles, permissions, recording state, hand
  raise, whiteboard open/closed.
- Delivery: reliable.
- Source of truth: server room state.
- Recovery: replay from retained room event log when available; otherwise full
  room snapshot.
- Version: global per-room `control_revision`.

### `whiteboard.scene`

- Examples: Excalidraw elements, clear, scene snapshot.
- Delivery: reliable for element updates; volatile for cursors.
- Source of truth: server materialized scene snapshot plus clients' optimistic
  local state.
- Recovery: snapshot first, optional short operation replay later.
- Version: `sceneId` as epoch plus server-owned `whiteboard_revision`.

### `chat`

- Delivery: durable database state; WebSocket is notification and acceleration.
- Source of truth: DB.
- Recovery: fetch by DB cursor / created time / message ID.
- Version: DB message sequence or monotonic created order, not WebSocket seq.

### `transcript`

- Delivery: durable database state; WebSocket is notification and acceleration.
- Source of truth: transcript segment store.
- Recovery: fetch missing segments by cursor.
- Version: segment sequence or provider timestamp plus stable insertion order.

## Proposed Reliable Message Contract

Reliable downstream messages should carry:

```ts
type ReliableEnvelope<T> = {
  stream: "room.control" | "whiteboard.scene" | "chat" | "transcript";
  roomId: string;
  eventId: string;
  fromRevision: number;
  revision: number;
  epoch?: string;
  serverTimeMs: number;
  payload: T;
};
```

Snapshots are the exception: they can declare a single `revision` without an
exact `fromRevision` because they replace the local projection for that stream.
All deltas should be exact-base transitions.

Reconnect should carry:

```ts
type ReconnectState = {
  desiredStreams: string[];
  cursors: Record<string, { revision: number; epoch?: string }>;
  pendingClientOps?: Record<string, unknown[]>;
};
```

Server response:

- If cursor is retained and valid: replay `[revision + 1, current]`.
- If cursor is missing, stale, or epoch mismatched: send snapshot at current.
- If client claims a future revision: reject the cursor and force snapshot.

## Proposed V1 Architecture

The near-term Chalk architecture should be smaller than Convex or Zero, but it
should borrow their most important invariants: server-owned versions, explicit
desired views, retained transitions, and snapshot fallback.

### 1. Introduce a Room Event Log

Add an append-only per-room log for durable-reliable control events:

```ts
type RoomEvent = {
  roomId: string;
  roomSeq: number;
  eventId: string;
  stream: "room.control" | "whiteboard.scene" | "chat" | "transcript";
  kind: string;
  actorParticipantId?: string;
  commandId?: string;
  occurredAtMs: number;
  payload: unknown;
};
```

Candidate storage:

- **Postgres outbox/event table**: best transactional fit for DB-owned state
  like permissions, recording, room lifecycle, chat, reads, and transcripts.
- **Redis Streams**: useful for low-latency fanout and short replay windows,
  but should not be the only source for DB-owned facts unless persistence and
  trimming policy are explicit.
- **Cloudflare Durable Object**: attractive for single-room ownership if Chalk
  moves room-control authority closer to the edge, but it would be a larger
  deployment architecture decision.

Conservative V1: Postgres event/outbox for authoritative room-control events,
plus Redis Pub/Sub or Streams as fanout acceleration.

### 2. Make Hubs Consumers, Not Sources

All API instances should update local caches by consuming the same event stream:

1. HTTP or WS command validates current authoritative state.
2. Command writes source-of-truth state and appends an event.
3. Hubs consume the event.
4. Hubs update process-local caches from the event.
5. Hubs deliver the event to connected clients.

Avoid direct domain-service `BroadcastToRoom` as the source of truth. Broadcast
should become a side effect of a committed event.

### 3. Version Snapshots By Domain

Room snapshot should become a set of versioned domains, not one timestamp:

```ts
type RoomSyncSnapshot = {
  roomId: string;
  controlRevision: number;
  presenceRevision?: number;
  whiteboard: {
    sceneId: string;
    revision: number;
    snapshotHash: string;
  };
  chat: {
    newestMessageRevision: number | null;
  };
  transcript: {
    newestSegmentRevision: number | null;
  };
  participants: Participant[];
  recording: RecordingState;
  whiteboardPermissions: Record<string, boolean>;
  raisedHands: Record<string, { raisedAtMs: number }>;
};
```

This mirrors Convex's `StateVersion` idea and Zero's cookie/CVR idea without
requiring Chalk to adopt query diffing.

### 4. Make Reconnect Declarative

Reconnect should declare what the client wants and what it has:

```ts
type SyncResume = {
  connectionId: string;
  desiredStreams: Array<"presence" | "room.control" | "whiteboard.scene" | "chat" | "transcript">;
  cursors: {
    controlRevision?: number;
    whiteboard?: { sceneId: string; revision: number };
    chatRevision?: number;
    transcriptRevision?: number;
  };
  pendingCommands?: Array<{ commandId: string; stream: string }>;
};
```

The server should choose per stream:

- replay if the cursor is retained and the epoch matches;
- snapshot if replay is unavailable or cheaper;
- reject and force full resync if the client claims a future revision.

### 5. Separate Command ACK From Broadcast

For user-visible commands, the sender needs an authoritative result even if the
broadcast path is delayed or the sender is excluded:

```ts
type CommandAck = { commandId: string; status: "committed"; revision: number } | { commandId: string; status: "duplicate"; revision: number } | { commandId: string; status: "rejected"; code: string; message: string };
```

This is especially important for whiteboard updates, permission changes,
recording controls, chat send, read receipts, and transcript submissions.

For commands that affect visible state, "committed" should mean the state change
has a durable revision. The client-facing promise should resolve when that
revision has been observed through the authoritative stream or snapshot. This
copies Convex's read-your-writes discipline without requiring Chalk to copy
Convex's query engine.

### 6. Track A Minimal Client View Record

Zero's CVR is too large for Chalk V1, but the smaller idea is valuable:

```ts
type ChalkClientView = {
  connectionId: string;
  participantId: string;
  authVersion: number;
  desiredStreams: string[];
  sent: {
    controlRevision?: number;
    whiteboard?: { sceneId: string; revision: number };
    chatRevision?: number;
    transcriptRevision?: number;
  };
  pendingCommandIds: string[];
  expiresAtMs: number;
};
```

Initially this can live in process memory and be rebuilt on reconnect. If Chalk
needs seamless multi-device or cross-instance continuation later, persist it
with version/owner checks like Zero does.

### 7. Treat Whiteboard As Snapshot-First

Whiteboard does not need a full OT/CRDT rewrite immediately. Excalidraw element
merge plus server snapshots are a practical foundation. The missing piece is an
authoritative server revision:

- `sceneId` remains the epoch.
- Server assigns `whiteboardRevision` for every accepted update or clear.
- Sender receives an ACK with `sceneId` and `whiteboardRevision`.
- Peers receive `whiteboard.data` with the same revision.
- Reconnect asks for `{sceneId, whiteboardRevision}`.
- Server sends replay only if retained; otherwise it sends
  `whiteboard.snapshot`.

If a clear happens, the old epoch is dead. Stale updates from the previous epoch
must never be accepted, replayed, or merged.

## Migration Plan

### Phase 0: Name The Contract

- Rename docs/comments so current `SendReliable` is described as
  live-reliable, not durable.
- Document which streams are volatile, live-reliable snapshot-healed, and
  durable-reliable.
- Stop treating `lastSeq` as a meaningful cursor in docs until it becomes one.

### Phase 1: Complete Snapshot Healing

- Add whiteboard permissions, raised hands, recording state from durable source,
  and room-ended state to room snapshots.
- Persist whiteboard permissions or derive them from a durable room-control
  source.
- Ensure SDK snapshot handling clears state when snapshots say the state is
  absent or false.
- Flush pending whiteboard persistence on graceful hub close.

### Phase 2: Add Room-Control Revisions

- Introduce `room_control_events` or equivalent outbox table.
- Assign monotonic per-room `control_revision`.
- Convert recording, permissions, hand raise/lower, participant update, and room
  end to append events.
- Make all hubs consume and apply these events locally before broadcasting.
- Add exact-base downstream envelopes and client gap detection.
- Add session-scoped command IDs with durable completion records for idempotent
  commands.

### Phase 3: Replay On Reconnect

- Replace `room.sync {lastSeq}` with stream cursors.
- Require desired stream intent before sending replay/snapshot state.
- Retain recent room-control events and replay from cursor.
- Fall back to versioned snapshot if cursor is stale.
- Add gap detection on the client: if an event's `fromRevision` does not match
  local cursor, request resync.
- Reject future cursors instead of accepting them as timestamps.

### Phase 4: Whiteboard Revision And ACKs

- Add server-owned `whiteboardRevision`.
- Add command IDs and ACKs for whiteboard updates and clears.
- Keep snapshot-first recovery; add short replay only after revisions and ACKs
  are stable.
- Include a snapshot hash for diagnostics.

### Phase 5: Chaos And Model Tests

- Add a deterministic sync harness that can drop, duplicate, reorder, and delay
  messages.
- Add multi-instance tests with clients split across two hubs.
- Assert convergence after reconnect and after process restart.
- Assert exact-base transition rejection for gaps, duplicates, future cursors,
  and stale cursors outside retention.
- Assert command promise resolution waits for authoritative revision observation.
- Test permission revoke racing with in-flight whiteboard updates.
- Test Redis publish/subscriber failure and snapshot recovery.

## Important Chalk Risks To Investigate Next

- Whether the product wants hand raise and whiteboard-open state to survive
  reconnect as authoritative room-control state or remain transient UI state.
- Whether recording state should be driven from DB, Cloudflare, Redis, or a
  room-control event projection when those disagree.
- Whether whiteboard files and app state have a single source of truth; current
  server snapshots return `{}` for `files` and `app_state`.
- Whether permission changes and whiteboard updates can race in a way that lets
  a revoked participant's already-in-flight update be accepted.
- Whether per-participant `seq` resets across reconnect/tab reload can cause
  stale suppression or duplicate acceptance edge cases.
- Whether Chalk wants Postgres outbox, Redis Streams, Durable Objects, or a
  hybrid for the first durable-reliable room log.

## Test Harness Direction

Build a deterministic sync model test harness before large rewrites:

- Model server streams with revisions, epochs, retained logs, snapshots.
- Model N clients with local state, cursors, optimistic pending ops, reconnects.
- Randomly drop, duplicate, delay, and reorder messages.
- Randomly force reconnects and server process restarts.
- Assert convergence after quiescence.
- Assert revisions never move backward.
- Assert stale whiteboard epochs cannot resurrect cleared content.
- Assert a reconnect always ends in either replay success or snapshot success.
- Assert duplicate client ops are idempotent by event ID.

## Open Design Decisions

- Snapshot-only vs replay for `whiteboard.scene` v1.
- How long to retain reliable room-control events.
- Whether to persist a room event log in Postgres, Redis Streams, Durable
  Objects, or another store.
- Whether whiteboard should use a global server revision only, or a hybrid of
  global revision plus per-actor sequence vector for diagnostics.
- Whether `room.sync` should evolve into stream-specific reconnect state.
- Whether to introduce a generic sync envelope now or migrate stream by stream.
- Whether command completion records should be stored in the same event table,
  a separate `room_command_results` table, or embedded in existing domain tables.
- Whether a V1 client view record should be process-local only or persisted with
  owner/version checks.

## Update Log

- 2026-05-30: Initial deep-dive notes from Convex, Zero, and current Chalk
  whiteboard/WebSocket inspection.
- 2026-05-30: Added deeper Chalk reliability pass covering live-vs-durable
  reliability, snapshot completeness, cross-instance fanout, current risk
  inventory, and a phased V1 sync architecture.
- 2026-05-30: Folded in subagent deep reads: Convex exact version chains,
  reconnect desired-state replay, durable mutation idempotency/read-your-writes;
  Zero exact-base pokes, explicit init connection, CVR ownership/version checks,
  commit watermarks, and durable mutation-result ACK cleanup.
