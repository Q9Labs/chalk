# Release-topology failure scheduler

`apps/sync/scripts/release-topology-failure-schedule` is the external control surface for deterministic Sync release-topology drills. It schedules provider and process actions around the deterministic breaker, which keeps owning commands, receipts, recovery, replica convergence, folds and invariant verdicts. The schedule contract is [`release-topology-failure-schedule-v1.schema.json`](./release-topology-failure-schedule-v1.schema.json); `lib/chalk_sync/release_topology/schedule.ex` holds the further public-safety checks, limits and required action markers.

**Modes.** Dry run is the default: it validates the full schedule and writes a `DRY_RUN` bundle without launching anything. Execution needs `--execute`, an exact `--confirm-environment`, and `CHALK_FAILURE_ORCHESTRATOR_ENV` set to the same value, which can be only `local` or `nightly`. Run a dry validation or an approved local drill from the repository root:

```bash
apps/sync/scripts/release-topology-failure-schedule --schedule <public-safe-schedule.json>

CHALK_FAILURE_ORCHESTRATOR_ENV=local apps/sync/scripts/release-topology-failure-schedule \
  --schedule <public-safe-schedule.json> --execute --confirm-environment local
```

**Safety shape.** The scheduler loads no credentials, sets no command environment, runs no shell, and allows no remote endpoint in a schedule. A control program gets operational credentials only through its deployment secret boundary and must finish in the foreground before its action timeout. Commands are argument vectors with bounded size and output, and a schedule cannot contain URLs, tokens, passwords, cookies, key references or database URLs. Output is never retained.

**Event order.** A `topology_check` first confirms that the deployed release, configuration and topology match the schedule's SHA-256 digests; a mismatch skips every event and fails the run. Each passing event then runs: declared trigger confirmed, injection, independent observation, telemetry, cleanup. The separate observation marker stops an injection command being mistaken for observed recovery. Any missing marker, nonzero exit, timeout, missing telemetry or failed cleanup fails the event and the run, and later mutations are skipped after cleanup. The topology control program checks the declared topology and keeps real clients under the trigger. A final breaker command checks the durable-control invariants against the drill's artifact, and the scheduler never widens the breaker's provider-control scope.

## Required campaign coverage

The launch campaign needs an event for each of these:

1. Sync SIGTERM and graceful replacement under accepted work.
2. Unclean Sync termination and supervisor or release restart.
3. Complete app-node replacement with reconnect and PostgreSQL authority preserved.
4. PostgreSQL notification loss until authoritative head-read repair.
5. Connection interruption before a transaction, during one, immediately before commit, and after commit before reply.
6. A slow or non-reading peer with an unacknowledged recovery page while healthy peers continue.
7. Telemetry exporter unavailability with bounded buffering or drop behavior.

Database interruption proves application recovery only. It makes no standby promotion, managed failover, backup, restore or PITR claim.

## Evidence

Each run writes an ignored bundle under `apps/sync/.artifacts/release-topology/<schedule>/<run-id>/` with a read-only manifest, a transitions log (`transitions.jsonl`), a verdict and a reproducer. The manifest holds digests, sanitized command-vector hashes, transition timestamps and the verdict, and only SHA-256 digests of command output and failure detail. Raw output, identities, tokens, provider IDs and endpoint URLs stay out of the bundle and repository. `DRY_RUN` is never launch evidence. A `PASS` bundle needs every event, observation, telemetry check, cleanup and the canonical breaker command to pass against the declared topology.
