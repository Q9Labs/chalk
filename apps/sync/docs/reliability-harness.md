# Sync reliability harness

One harness owns Sync reliability. Triggers select how deeply it runs:

| Trigger           | Profile       | What blocks                          |
| ----------------- | ------------- | ------------------------------------ |
| Pull request      | `correctness` | Merge                                |
| Nightly schedule  | `topology`    | The scheduled check                  |
| Release candidate | `release`     | Manual check; not wired to promotion |

The correctness profile runs the full PostgreSQL-backed Sync suite with zero
skips, the replayed v1 breaker, the TypeScript Sync client, and the separate
whiteboard transport. The topology profile starts real Sync OS processes and a
PostgreSQL primary/standby pair, then covers cross-node convergence, client
partitions, unclean node loss, whiteboard fanout, and database promotion. The
release profile includes both profiles plus concurrent multi-node load, process
restart recovery, and a real Chromium client.

Every profile fails on the first missing or failed proof. It writes a read-only
manifest under “apps/sync/.artifacts/reliability/” with the commit, relevant
working-tree fingerprint, exact commands, durations, verdict, and reproducer.
CI uploads that directory so a green check has reviewable evidence.

Run the profiles from the repository root:

```bash
scripts/gates/with-postgres.sh apps/sync/scripts/reliability-correctness
scripts/gates/with-sync-topology.sh apps/sync/scripts/reliability-topology
apps/sync/scripts/reliability-harness release
```

The release command provisions its own databases when no test database URL is
set. `CHALK_SYNC_SOAK_CLIENTS`, `CHALK_SYNC_SOAK_COMMANDS`,
`CHALK_SYNC_SOAK_COMMAND_INTERVAL_MS`, `CHALK_SYNC_SOAK_DURATION_SECONDS`, and
`CHALK_SYNC_SOAK_P95_BUDGET_MS` tune the sustained workload without changing
the correctness oracle. Release CI runs it for at least five minutes.

## Crash-recovery contract

`test/chalk_sync/reliability/recovery_contract_test.exs` runs in the PR
`correctness` profile through the full Sync gate. It reuses `ExternalSyncNode`,
the v1 wire client, the Postgres fixtures, and the Stateholder fault hooks.
It has no topology tag, external provider dependency, or in-memory storage.
The five tests took 13.3 seconds on Instabox, including 20 Sync process starts.
That is test time, not machine provisioning, dependency download, or compilation
time. This is small enough for the existing PR gate rather than the nightly
topology profile.

The boundaries follow the actual transaction, not three independent writes:

| Kill point                                                              | Expected durable result before retry              |
| ----------------------------------------------------------------------- | ------------------------------------------------- |
| Command accepted, before transaction                                    | No target event or receipt                        |
| Event inserted, control updated, or receipt inserted inside transaction | Entire target transaction rolls back              |
| Commit completed, reply not sent                                        | Event, folded state, and receipt survive together |
| Client received receipt                                                 | Same event, state, and stable receipt survive     |

The command journey starts with an acknowledged command, parks the target at
each hook over a TCP barrier, sends SIGKILL to the separate Sync BEAM, and starts
a fresh process. It checks recovered snapshot content, stable duplicate receipts,
exact event/receipt counts, and the replay payload and digest. The received-ack
case kills only after the client reads its receipt. No sleep chooses a kill point.

The join journey also kills after lifecycle event insertion, intent
application, webhook production, and commit. It requires exactly one lifecycle
event, webhook Event, and queued delivery. The test then redelivers the same
intent and compares the durable rows. This checks join and webhook production,
not provider-side leave or end operations, or HTTP delivery by the API worker.

The source rules are the root `AGENTS.md` (Postgres authority), `README.md` (Durable
architecture and Lifecycle), and `../../../theory.md` (Sync authority).
`Stateholder.Postgres.decide_command/2` places the acceptance and post-commit
hooks around `run_decision_transaction/2`; `CommandPersistence.commit/5` puts
the event/control/receipt hooks inside that transaction. `Lifecycle.persist_commit/6`
puts lifecycle event, intent, and webhook writes inside its transaction;
`Stateholder.Postgres.apply_lifecycle/3` exposes the post-commit boundary.
These hooks are configured only in the test child script, not production.
