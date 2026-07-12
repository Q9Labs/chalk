# Sync breaker v2

`apps/sync/scripts/sync-breaker-v2` is a deterministic, non-security stress
harness for the protocol-v2 durable-control path. It has no named load
profiles. Every load dimension is a bounded CLI value recorded in the artifact
manifest.

`--duration-ms 0` runs a command-count campaign and executes exactly
`--commands` operations. A positive `--duration-ms` declares a minimum wall
duration. It requires at least `ceil(duration_ms * command_rate / 1000)`
commands, runs that many operations, and waits if the operations finish early.
Slow dependencies can extend a campaign beyond the requested duration. The
duration range is 0 through 28,800,000 ms (eight hours), and the command cap
is 100,000 operations. An eight-hour soak at one operation per second uses
`--duration-ms 28800000 --command-rate 1 --commands 28800`; higher-rate
eight-hour requests that need more than 100,000 operations are rejected.

Run the required local Memory smoke scenario:

```bash
apps/sync/scripts/sync-breaker-v2 run \
  --adapter memory \
  --seed 20260712 \
  --sessions 1 \
  --participants 2 \
  --sockets 2 \
  --subscriptions 1 \
  --commands 24 \
  --command-rate 1000 \
  --burst 4 \
  --concurrency 1 \
  --cursor-age 0 \
  --client-read-delay-ms 0 \
  --network-interrupt-every 0 \
  --duration-ms 0
```

The local Postgres campaign uses the isolated sync test database support. It
creates and removes its own tenant/Session fixtures.

```bash
CHALK_SYNC_TEST_DATABASE_URL='postgres://…' \
apps/sync/scripts/sync-breaker-v2 run \
  --adapter postgres \
  --postgres-topology local \
  --fault-point after_commit_before_reply \
  --migration-version <applied-version> \
  --sessions 2 --participants 2 --sockets 4 --commands 100 \
  --command-rate 1000 --burst 8 --concurrency 2
```

The campaign uses current v2 `Command`, `Stateholder`, recovery, and
protocol-v2 frame APIs. It records and checks exact revisions and order,
stable command receipts and command-ID conflicts, state digests, snapshots,
and convergence of every requested replica. `--fault-point` accepts `none`,
`before_transaction`, `after_transaction_begin`, `after_authority_lock`,
`after_receipt_lookup`, `after_event_insert`, `after_control_update`,
`after_receipt_insert`, `before_commit`, and `after_commit_before_reply`.
Pre-commit injections must roll back and resolve on the stable command retry;
the post-commit injection must resolve from its authoritative receipt.

Artifacts default to `apps/sync/.artifacts/sync/<git-sha>/<run-id>/` and include
`manifest.json`, `verdict.json`, `trace.jsonl`, `metrics.json`, log placeholders,
`failure.md`, and `reproducer.json`. The manifest records whether the worktree
was dirty plus a digest of the Git status; release evidence must come from a
clean worktree. Artifacts contain generated IDs and command metadata only. They
contain no participant tokens, names, or payload bodies.

Replay a captured trace without a running server or database:

```bash
apps/sync/scripts/sync-breaker-v2 replay apps/sync/.artifacts/sync/<git-sha>/<run-id>
```

The current local adapter campaign accepts a local Postgres topology and no
notification or restart schedule. Those dimensions remain intentionally
rejected in the breaker, so the harness never reports unsupported operational
proof as passing. The external
[release-topology failure scheduler](./release-topology-failure-scheduler.md)
owns the separately versioned provider and process controls, records their
transitions, and invokes the breaker as the canonical invariant verifier.
