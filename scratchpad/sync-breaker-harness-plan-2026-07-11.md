# Chalk Sync Breaker

Chalk Sync Breaker is a local, test-only stress harness for the Elixir sync
engine. Its job is to expose state divergence, revision discontinuities,
incorrect retry outcomes, replay failures, and writer lifecycle defects with a
deterministic history and a complete trace.

The harness starts an ephemeral Bandit listener on localhost. It cannot target
a remote sync service. Run artifacts are written below `.private/sync-breaker/`
by default and remain outside the public repository.

## Correctness contract

Every run checks the following properties where they apply:

1. Committed events form an exact `base_revision -> revision` chain.
2. Connected replicas converge to the stateholder snapshot at the same
   revision.
3. A committed command has one stable outcome across retries.
4. A rejected command does not mutate authoritative state.
5. Replaying retained events reconstructs the authoritative snapshot.
6. A cursor outside retention falls back to a convergent snapshot.
7. Abrupt disconnect and reconnect preserve the replica or repair it through
   replay or snapshot.
8. Concurrent commands serialize into one authoritative history.
9. Closing one of several subscriptions for one participant does not emit a
   premature leave transition.
10. A writer restart or revision conflict does not strand incorrect process
    state.
11. Fanout to a non-reading subscriber stays within the configured observation
    bound.
12. Direct replay rejects non-contiguous revision jumps.

## Architecture

The harness has four layers:

- An independent pure model applies operations without calling the production
  `Room` implementation.
- A seeded generator records invocations, completions, events, snapshots, and
  replay observations in a portable history.
- Real WebSocket actors maintain independent replicas while commands,
  concurrent sends, abrupt disconnects, reconnects, and writer restarts are
  applied.
- Scripted stateholder checkpoints pause exact commit boundaries without
  timing sleeps, allowing deterministic commit ambiguity and revision-conflict
  tests.

The checker validates revision continuity, convergence, acknowledgement/event
agreement, rejected-command immutability, replay equivalence, and idempotency.
Pure-model failures can be reduced with the included shrinker.

## Composable scenarios

The CLI exposes independent scenarios rather than fixed profiles:

- `model`
- `random_wire`
- `idempotency_retry_after_writer_restart`
- `reconnect_replay_convergence`
- `replay_revision_jump_probe`
- `commit_ambiguity`
- `writer_conflict_orphan`
- `idempotency_eviction`
- `slow_subscriber`
- `retention_snapshot_fallback`
- `multiple_subscriptions_lifecycle`

`random_wire` mixes sequential commands, concurrent commands, abrupt TCP
disconnects, reconnects, and optional writer restarts. Retries and writer
restarts are independent switches, allowing a dominant failure to be disabled
while the rest of the state space continues running.

## Running it

From `apps/sync`:

```sh
MIX_ENV=test mix sync.breaker \
  --seed 872193 \
  --cases 32 \
  --steps 1000 \
  --participants 8 \
  --scenarios model,random_wire,reconnect_replay_convergence
```

The command exits nonzero when an invariant fails. This is intentional: the
terminal verdict and report path make a failed campaign visible in local runs
and CI.

To explore convergence without retry or restart failures masking later steps:

```sh
MIX_ENV=test mix sync.breaker \
  --cases 32 \
  --steps 1000 \
  --participants 8 \
  --no-retries \
  --no-writer-restarts \
  --scenarios random_wire
```

## Artifacts

Each run directory contains:

- `report.md`: failure-first human summary;
- `summary.json`: machine-readable verdict, metadata, evidence, and traces;
- one numbered JSONL result trace per scenario case;
- one model JSONL history per generated model case.

Every report result includes the exact path of its numbered trace. Trace entries
use monotonic sequence numbers and preserve the materialized operation or wire
observation needed to understand the transition. Tokens are never recorded.

## Verification strategy

Focused ExUnit tests cover each generator, checker, shrinker, trace writer,
fault checkpoint, wire actor, scenario, and report boundary. Larger local
campaigns then exercise many deterministic seeds. Confirmed engine failures are
kept as detector tests whose expected result is a structured harness failure;
they are not weakened into passing engine assertions.
