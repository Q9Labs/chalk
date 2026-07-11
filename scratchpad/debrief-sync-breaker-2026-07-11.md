# Sync Breaker Debrief

## Grand summary

Chalk now has a local, test-only breaker that attacks sync correctness through
an independent model, real WebSocket actors, deterministic commit checkpoints,
and focused lifecycle probes. It emits failure-first Markdown, machine-readable
summaries, and complete JSONL traces. The harness is solid after three review
passes; the engine needs attention because six correctness invariants fail
reproducibly.

## Walkthrough

- `apps/sync/lib/mix/tasks/sync.breaker.ex:1` is the test-only CLI. It validates
  scenario selection, runs the campaign, prints the report path, and exits
  nonzero on an invariant failure.
- `apps/sync/test/support/sync_breaker/model.ex:1` defines the independent room
  model used as the oracle. It rejects revision gaps and invalid state
  transitions without calling production `Room` code.
- `apps/sync/test/support/sync_breaker/history.ex:1` and
  `generator.ex:1` materialize deterministic operations, events,
  acknowledgements, snapshots, and replay observations from a seed.
- `apps/sync/test/support/sync_breaker/checker.ex:1` composes the offline
  continuity, convergence, acknowledgement/event, immutability, replay, and
  idempotency checks. `shrinker.ex:1` reduces a failing operation history.
- `apps/sync/test/support/test_ws_client.ex:27` preserves raw WebSocket frames
  and connection state across timeouts. `wire_actor.ex:1` builds an independent
  client replica over that transport.
- `apps/sync/test/support/sync_breaker/random_wire_campaign.ex:11` runs each
  seeded wire case in its own socket-owning process, mixing commands,
  concurrency, reconnects, retries, and writer restarts without leaking old TCP
  messages into later cases.
- `apps/sync/test/support/scripted_stateholder.ex:1` provides exact before/after
  commit checkpoints. `fault_scenarios.ex:11` uses them for commit ambiguity,
  revision conflict, idempotency retention, slow subscriber, retention, and
  subscription-lifecycle probes.
- `apps/sync/test/support/sync_breaker/scenarios.ex:14` owns focused real-wire
  retry and replay checks plus the direct revision-gap detector.
- `apps/sync/test/support/sync_breaker/trace_writer.ex:1` preserves exact JSON
  types in replay artifacts. `report.ex:1` writes the human and machine
  summaries.
- `scratchpad/sync-breaker-findings-2026-07-11.md:1` is the failure report. It
  explains six confirmed engine defects and links the complete local traces.

## Findings

- **Major — correctness:** The engine loses command outcomes after writer
  restart, FIFO eviction, and commit/ack interruption. These are the three
  high-severity failures in
  `scratchpad/sync-breaker-findings-2026-07-11.md:19`; command identity and its
  outcome should be committed atomically in authoritative storage.
- **Major — correctness/performance:** Empty restarted writers, unbounded slow
  subscriber mailboxes, and accepted revision jumps remain reproducible at
  `scratchpad/sync-breaker-findings-2026-07-11.md:87`. Fix each engine boundary
  and promote the corresponding detector from an expected structured failure
  to a passing regression.
- **Minor — maintainability:** `random_wire_campaign.ex`, `fault_scenarios.ex`,
  and `scenarios.ex` are intentionally scenario-dense and now exceed the usual
  module-size preference. Split them by campaign dimension when adding the next
  scenario family; changing their boundaries now would add churn without
  improving the verified behavior.
