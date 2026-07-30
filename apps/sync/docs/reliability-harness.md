# Sync reliability harness

One harness owns Sync reliability. Triggers select how deeply it runs:

| Trigger           | Profile       | What blocks         |
| ----------------- | ------------- | ------------------- |
| Pull request      | `correctness` | Merge               |
| Nightly schedule  | `topology`    | The scheduled check |
| Release candidate | `release`     | Promotion           |

The correctness profile runs the full PostgreSQL-backed Sync suite with zero
skips, the replayed v3 breaker, the TypeScript Sync client, and the separate
whiteboard transport. The topology profile starts real Sync OS processes and a
PostgreSQL primary/standby pair, then covers cross-node convergence, client
partitions, unclean node loss, whiteboard fanout, and database promotion. The
release profile includes both profiles plus concurrent multi-node load, process
restart recovery, and a real Chromium client.

Every profile fails on the first missing or failed proof. It writes a read-only
manifest under `apps/sync/.artifacts/reliability/` with the commit, relevant
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
