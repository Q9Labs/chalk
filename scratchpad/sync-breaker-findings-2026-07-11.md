# Chalk Sync Breaker Findings

Date: 2026-07-11
Scope: sync state correctness, retry stability, replay convergence, disconnect
recovery, writer lifecycle, event retention, and fanout behavior.

## Verdict

The sync engine is **not done** against the tested correctness contract. The
harness confirmed six invariant failures with deterministic reproductions. The
independent model, concurrent real-wire operation, abrupt reconnect replay,
writer-restart convergence without retries, retention fallback, and
multi-subscription lifecycle checks passed.

The harness itself completed every campaign without a harness error. The sync
server quality gate passes 82 tests with zero failures.

## Confirmed issues

### 1. Command outcomes are lost when a room writer restarts — high

`RoomServer` stores command outcomes only in the writer process. `init/1`
creates an empty `remembered` map on every start. A retry after a restart is
therefore executed again against current room state instead of returning the
original outcome.

The focused reproduction committed `command-1` at revision 2, restarted the
writer, and retried the same command ID. The retry returned `rejected:
no_change` instead of `duplicate` at revision 2. The final mixed random-wire
campaign reproduced an unstable retry outcome in all eight configured seeds.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room_server.ex:84` initializes the rebuilt
  writer from room state.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:101` initializes an empty local
  command-outcome cache.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:131` relies exclusively on that
  local cache for duplicate detection.

Required direction: persist the session-scoped command outcome with the
authoritative state transition, then hydrate or query it when a writer starts.

### 2. A live writer forgets command outcomes after 256 later IDs — high

The command-outcome cache is a fixed FIFO of 256 entries. Once an entry is
evicted, retrying that command ID can commit at a new revision, turn an earlier
rejection into a commit, or turn an earlier commit into `no_change`.

The exact reproduction committed the original ID at revision 2, inserted 256
later command IDs, and observed the original ID commit again at revision 4. A
long random-wire campaign with writer restarts disabled reproduced changed
outcomes in six of eight seeds. This isolates the defect from writer restart.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room_server.ex:239` inserts every command
  result into the local FIFO.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:243` evicts the oldest outcome
  after the map exceeds 256 entries.

Required direction: define the actual session lifetime and retain stable
outcomes for that lifetime in authoritative storage. A bounded cache can remain
as an optimization over the durable lookup.

### 3. A commit can succeed without a recoverable acknowledgement — high

The scripted stateholder paused immediately after the authoritative commit and
then terminated the writer before `GenServer.call/3` returned. The room reached
revision 2, while the caller received `rejected: retry`. A new writer could not
recover the command result, and the same command ID returned `rejected:
no_change`.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room_server.ex:55` converts every command-call
  exit into `rejected: retry`.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:194` commits authoritative
  state before the command result is retained in writer memory.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:144` remembers the result only
  after `execute/4` returns to the writer loop.

Required direction: commit the command ID and its outcome atomically with the
state event. A retry can then recover the committed result after any writer or
caller interruption.

### 4. Revision-conflict restart leaves an empty room writer alive — medium

A forced compare-and-set conflict stops the writer abnormally. Its transient
child specification restarts it immediately. The new process has zero
subscribers and no lifecycle event that can trigger the normal empty-room stop
path.

The exact reproduction observed a new live writer with zero subscribers after
the old writer returned `rejected: retry` and exited.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room_server.ex:141` stops with
  `revision_conflict`.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:84` permits the supervisor to
  rebuild the process with no subscribers.
- `apps/sync/lib/chalk_sync/rooms/room_server.ex:163` performs empty cleanup only
  while handling a subscriber `DOWN` message.

Required direction: prevent an empty abnormal restart from persisting, or give
rebuilt writers an explicit idle shutdown path.

### 5. Fanout to a non-reading subscriber grows its mailbox linearly — medium

The writer sends every committed event to every subscriber without an
acknowledgement, queue bound, coalescing rule, or disconnect threshold. A
non-reading subscriber accumulated 1,001 queued messages after 1,000 committed
events; the observation bound was 128.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room_server.ex:215` sends directly to every
  subscriber process.

Required direction: define a maximum per-subscriber backlog and force a
snapshot/reconnect recovery path when a subscriber falls behind that bound.

### 6. The pure room accepts a non-contiguous event revision — medium

`Room.apply_event/2` verifies `base_revision` but assigns any supplied
`revision`. A direct event with base revision 0 and revision 5 was accepted and
advanced the room to revision 5. The room module documents an exact revision
chain, so this behavior violates its own replay contract.

Relevant engine code:

- `apps/sync/lib/chalk_sync/rooms/room.ex:57` matches the base revision.
- `apps/sync/lib/chalk_sync/rooms/room.ex:58` assigns the event revision without
  checking that it equals `base_revision + 1`.

Required direction: require `event.revision == room.revision + 1` in the pure
state transition and return an explicit error for a gap.

## Passing boundaries

- 100 seeds and 100,000 generated pure-model operations passed all checker
  invariants with 16 participants per case.
- 16 seeds and 8,000 real-wire steps passed with retries and writer restarts
  disabled. These steps mixed sequential commands, concurrent commands, abrupt
  disconnects, reconnects, and full replica-to-stateholder comparisons across
  eight participants.
- Eight seeds and 2,000 real-wire steps passed with writer restarts enabled and
  retries disabled.
- Abrupt TCP loss reconstructed the replica through an exact retained replay
  and matched a fresh authoritative snapshot.
- A cursor older than the 500-event retention window received a snapshot at
  revision 503 and matched authoritative state.
- Closing one of two subscriptions for the same participant preserved the
  participant at the same revision; the remaining subscription could commit
  the next command.

## Run artifacts

Complete reports and numbered JSONL traces are available locally:

- Pure model pass:
  `.private/sync-breaker/20260711T123439.542768-seed-970000-738/report.md`
- Real-wire concurrency and reconnect pass:
  `.private/sync-breaker/20260711T124220.722912-seed-980000-2372/report.md`
- Real-wire writer-restart pass with retries disabled:
  `.private/sync-breaker/20260711T124220.619901-seed-990000-2370/report.md`
- Long retry failures with writer restarts disabled:
  `.private/sync-breaker/20260711T124220.960636-seed-997000-2370/report.md`
- Focused invariant matrix:
  `.private/sync-breaker/20260711T124220.819504-seed-996000-2370/report.md`
- Mixed retry and writer-restart failures:
  `.private/sync-breaker/20260711T124221.087239-seed-995000-2370/report.md`

Each report result names its exact JSONL trace. The corresponding
`summary.json` retains the complete normalized evidence and trace for machine
analysis.
