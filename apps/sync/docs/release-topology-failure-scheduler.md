# Release-topology failure scheduler

`apps/sync/scripts/release-topology-failure-schedule` is the external control
surface for deterministic Sync release-topology drills. It schedules provider
and process actions around the deterministic breaker. The breaker continues to
own commands, receipts, recovery, replica convergence, folds, and invariant
verdicts.

The scheduler has two intentionally separate modes:

- Dry run is the default. It validates the full versioned schedule and writes a
  `DRY_RUN` evidence bundle without launching any command.
- Execution requires `--execute`, an exact `--confirm-environment` value, and
  `CHALK_FAILURE_ORCHESTRATOR_ENV` set to that same `local` or `staging`
  value. `production` is not a valid schedule environment.

Run a dry validation from the repository root:

```bash
apps/sync/scripts/release-topology-failure-schedule \
  --schedule <public-safe-schedule.json>
```

Run an explicitly approved local drill:

```bash
CHALK_FAILURE_ORCHESTRATOR_ENV=local \
apps/sync/scripts/release-topology-failure-schedule \
  --schedule <public-safe-schedule.json> \
  --execute \
  --confirm-environment local
```

Staging uses the same command with `staging` in both required places. The
scheduler does not load credentials, set command environments, execute a
shell, or support remote endpoints in a schedule. A local or staging control
program obtains any operational credentials only through its deployment secret
boundary. It must run in the foreground and complete before its action timeout.

## Schedule v1

The machine-readable contract is
[`release-topology-failure-schedule-v1.schema.json`](./release-topology-failure-schedule-v1.schema.json).
The scheduler validates every structural field itself, rejects unknown fields,
and adds public-safety checks for command arguments.

Every schedule names a clean release, rendered configuration, and topology by
SHA-256 digest. Its required `topology_check` action independently confirms
that the deployed release, configuration, and topology match those digests
before any mutation. A mismatch skips every event and fails the run. The
scheduler invokes one bounded breaker command after all events pass. Every
event contains these fields:

- A public-safe ID and declared trigger.
- Failure duration, expected readiness state, expected client outcome,
  recovery deadline, and one or more breaker invariants.
- A `trigger_check`, `inject`, `observe`, `telemetry`, and `cleanup` command.

Commands are argument vectors. The scheduler starts the executable directly,
without a shell, limits each vector to 64 arguments and 1 KiB per argument,
caps command output at 64 KiB, and closes the process port at its declared
timeout. The schedule cannot include URLs, tokens, passwords, cookies, key
references, or database URLs. It never retains command output.

Action commands must exit zero and print exactly one of the following markers,
after surrounding whitespace is removed:

| Action | Required marker |
| --- | --- |
| `trigger_check` | `confirmed` |
| `inject` | `injected` |
| `observe` | `confirmed` |
| `telemetry` | `available` |
| `cleanup` | `cleaned` |

The independent observation marker prevents an injection command from being
mistaken for observed recovery. A missing marker, nonzero exit, timeout,
missing telemetry marker, topology mismatch, or failed cleanup makes the event
and the complete run fail. After a failed event, the scheduler runs its cleanup
and skips later mutations.

The execution order for a passing event is:

```text
declared trigger confirmed → injection → independent observation → telemetry → cleanup
```

The topology control program is responsible for checking the declared topology
and keeping real clients under the declared trigger while the scheduled failure
occurs. The final breaker command then checks the canonical durable-control
invariants against that drill's artifact. The scheduler never expands the
breaker's provider-control scope.

## Required campaign coverage

The launch campaign has individual events for the approved readiness scenarios:

1. Sync SIGTERM and graceful replacement under accepted work.
2. Unclean Sync termination and supervisor or release restart.
3. Complete app-node replacement with reconnect and PostgreSQL authority
   preserved.
4. PostgreSQL notification loss until authoritative head-read repair occurs.
5. Connection interruption before a transaction, during a transaction,
   immediately before commit, and after commit before reply.
6. A slow or non-reading peer with an unacknowledged recovery page while
   healthy peers continue.
7. Telemetry exporter unavailability with bounded buffering or drop behavior.

Database interruption proves application recovery only. It makes no standby
promotion, managed failover, backup, restore, or PITR claim.

## Evidence

Each run writes an ignored bundle under
`apps/sync/.artifacts/release-topology/<schedule>/<run-id>/` by default. It
contains `manifest.json`, `transitions.jsonl`, `verdict.json`, and
`reproducer.json`. The manifest is made read-only after it is written.

The manifest holds the scheduler version, environment, versioned schedule,
release/configuration/topology digests, sanitized command-vector hashes,
monotonic and wall-clock transition timestamps, and verdict. It records only
SHA-256 digests of command output and failure detail. Raw command output,
identities, tokens, secret values, provider IDs, and endpoint URLs remain out
of the bundle and repository.

`DRY_RUN` is a validation result. It is never launch evidence. A `PASS` bundle
requires every scheduled event, observed transition, telemetry check, cleanup,
and the canonical breaker command to pass against the declared topology.
