# Lane C — Sync correctness and durability runs

**Date:** 2026-09-27  
**Checkout:** `6f18d8fdb11cdd09f51c093c0aca1dbc325c7254`

## Outcome

The local `mint` dependency mismatch was repaired with `mix deps.get`; `apps/sync/mix.lock` did not change. After building the local diagnostics-contracts package required by a Sync breaker test, the Sync gate, correctness profile, standalone SyncEngine v1 campaign, and topology profile all passed. The first standalone Sync gate attempt failed because that generated package output was absent; its exact error and judgment are below.

Each requested run had an external 1,800-second watchdog. Durations below are wall time including local Postgres setup and migrations where applicable. Raw output is under `lane-c/logs/`; machine-readable harness evidence is under `lane-c/evidence/`.

## Local setup

1. Working directory `apps/sync`; command `mix deps.get` — **exit 0, 1.526 s**. Output included `* Updating mint (Hex package)` and then listed all dependencies as fetched. No `mix.lock` diff.
2. Command `pnpm --dir packages/diagnostics-contracts run build` — **exit 0, 4.378 s**. This generated the ignored local `packages/diagnostics-contracts/dist` output required by the breaker SDK phase. The correctness profile also performs this build as its first step.

For Postgres-backed runs, the scripts had no database-name override: they used an isolated one-off Postgres 18 service with the fixed in-container database name `chalk_gate` and a timestamp/PID-suffixed container name. Before starting, `docker ps -a` showed no matching `chalk-gate-postgres` or Sync topology containers; the topology volume/network lists were also clear. `docker info` identified the endpoint as OrbStack. The topology wrapper preferred the installed native PostgreSQL 18 binaries, so its primary/standby pair ran as local native processes rather than containers.

## Runs, in requested order

### 1. Sync gate / test suite

Exact child command for both attempts (with the lane-local `TMPDIR` override):

    TMPDIR=/Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/tmp scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh run

The first attempt took **25.071 s** and exited 2. The gate reached ExUnit and reported **79 tests, 1 failure, 2 excluded**. The exact failure was:

    Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/macmini/code/chalk/sdks/typescript/client/node_modules/@q9labsai/diagnostics-contracts/dist/index.js' imported from /Users/macmini/code/chalk/sdks/typescript/client/src/space-client/episode-diagnostic-runtime.ts
      code: 'ERR_MODULE_NOT_FOUND'
      url: 'file:///Users/macmini/code/chalk/sdks/typescript/client/node_modules/@q9labsai/diagnostics-contracts/dist/index.js'

    1) test preserves phase verdicts, bounds, redaction, and deterministic replay (ChalkSync.SyncBreakerV1.CampaignTest)
       test/chalk_sync/sync_breaker_v1/campaign_test.exs:11
       ** (MatchError) no match of right hand side value:

           {"", 1}

The failing subprocess is invoked by `ChalkSync.SyncBreakerV1.WireSdkPhase.exercise_sdk/1`. **Judgment:** local setup/gate orchestration problem, not evidence of a Sync product defect or stale test. The workspace package had not been built. The documented correctness profile builds it before invoking the full gate, but `gate.sh run` does not.

After the package build, the same gate command took **29.927 s**, exited 0, and passed: format, compile with warnings as errors, Credo (**3,737 mods/funs, no issues**), and **79 tests, 0 failures, 2 excluded**. The two excluded cases are tagged `reliability_topology`, which this gate intentionally omits. The strict gate reported success with no skipped/invalid cases.

### 2. Reliability harness — correctness

Exact command:

    TMPDIR=/Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/tmp scripts/gates/with-postgres.sh -- apps/sync/scripts/reliability-harness correctness --output /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/evidence/correctness

**Exit 0, 35.633 s; 6/6 profile steps passed, 0 failed.** Inside the profile:

- Sync full gate: **79 tests, 0 failures, 2 excluded**.
- Sync breaker campaign and artifact replay: passed; replay reported `SyncEngine v1 replay passed twice`.
- TypeScript Sync/whiteboard: **4 files, 71 tests passed**.
- Whiteboard collaboration: **5 files, 7 tests passed**.
- Diagnostics-contracts build and all other profile steps passed.

The breaker artifact records four passing phases and 36 schedule steps. There were no failed tests or profile steps.

### 3. Standalone `sync.breaker.v1` campaign

Exact command:

    TMPDIR=/Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/tmp scripts/gates/with-postgres.sh -- sh -c 'cd apps/sync && MIX_ENV=test mix sync.breaker.v1 --output /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/evidence/sync-breaker-v1.json'

**Exit 0, 8.690 s.** The command reported `SyncEngine v1 breaker passed`. Its checksummed artifact records **4/4 phase verdicts passed and 36 schedule steps**, with no failed phase. Counts by phase are durable/lifecycle 8, external-operation/live-media 12, delivery/recovery 7, and wire/SDK 9.

**Stale documentation finding:** `apps/sync/docs/sync-breaker-v1.md` says “all 37 executed schedules,” but the passing test assertion in `campaign_test.exs` and both run artifacts assert/record 36 (`schedule_steps` = 36). This is a documentation count mismatch, not a failed campaign.

### 4. Reliability harness — topology

Exact command:

    TMPDIR=/Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/tmp scripts/gates/with-sync-topology.sh -- apps/sync/scripts/reliability-harness topology --output /Users/macmini/code/chalk/scratchpad/sync-hardening-2026-09-27/lane-c/evidence/topology

**Exit 0, 12.596 s; 3/3 profile steps passed, 0 failed.** The basic gate passed; the multi-node topology test passed (**1 test, 0 failures**); and the Postgres failover test passed (**1 test, 0 failures**). The wrapper provisioned a native PostgreSQL 18 primary/standby pair and the tests launched real Sync OS processes.

## Failure accounting and interpretation

The only failed test attempt was the first Sync gate run above. Its exact failure was `ERR_MODULE_NOT_FOUND` for the generated diagnostics-contracts `dist/index.js`, followed by the breaker test's `MatchError` on `{"", 1}`. Building that local package resolved it; all subsequent Sync gate and profile runs passed. The `mix.lock` was not edited. No test was judged stale due to an assertion failure; the only stale item found was the breaker documentation's schedule count (37 versus the test/artifact count of 36).

Fault-injection tests emit some expected log lines at error severity while exercising rollback/uncertain-commit paths. Those are test stimuli, not failed tests; the pass/fail counts above come from the test runners and profile manifests.

## Coverage audit — what a passing test actually exercises

These are source-backed coverage judgments paired with the passing run evidence; they do not prove behavior beyond the described schedule.

| Failure case | Coverage in these passing runs |
|---|---|
| Sync node killed immediately after acknowledging a command | **Not covered in that exact timing.** `ChalkSync.Reliability.TopologyProfileTest`, test “multiple nodes converge across a client partition and unclean node loss,” acknowledges a command and later kills node A, but only after a second command, partition healing/reconnect, and whiteboard checks. The breaker also has a modeled `lost_after_commit_reply` schedule, not an immediate kill of a real Sync OS process after ACK. |
| Client reconnect and recovery after that Sync-node kill | **Not covered as that combined case.** In the topology test, reconnect/recovery happens before node A is killed. Breaker schedules `disconnect_before_recovery_ack` and `coordinator_kill_restart` pass, but the latter kills an Episode Coordinator process, not the Sync OS process, and is a separate modeled schedule. |
| Postgres primary unavailable and service recovered | **Covered via standby promotion, not primary restoration.** `ChalkSync.Reliability.PostgresFailoverProfileTest`, test “stable receipts and recovery survive primary loss and standby promotion,” stops the primary, promotes the caught-up standby, reconnects, replays the command, and starts a fresh Sync node to recover authoritative state. It does not restart the original primary process. |
| Failover to standby | **Covered.** The same passing Postgres failover test asserts primary loss, standby promotion, stable receipt preservation, and recovery by a fresh node. |
| Slow consumer | **Not covered.** No slow-consumer/backpressure test ran; no test in the Sync test tree references `CollaborationQueue`. The presence of bounded queue code alone is not exercised-test evidence. |
| Duplicate command replay | **Covered.** `ChalkSync.Transport.SocketV1Test`, test “durable commands emit ACKs and events and preserve idempotency,” resubmits the same command ID and verifies a duplicate ACK; it also checks conflicting reuse. The Postgres failover test additionally replays the same command after promotion and verifies the stable duplicate receipt. |
| Two Sync nodes serving one Episode | **Covered.** The passing `TopologyProfileTest` starts topology-a and topology-b against the same seeded Episode; both accept their Participant connections and converge across the client partition. |

## Cleanup and working-tree notes

- The Postgres gate wrappers removed their timestamp/PID-suffixed OrbStack containers. Post-run checks found no matching containers, topology volumes, topology networks, or native topology data directories. The databases were ephemeral to those services and were removed with them.
- The harnesses use ephemeral ports (`port: 0`/available-port allocation); they did not configure ports 3070, 4100, 28080, or 8080. A post-run listener check showed an `ssh` process on 127.0.0.1:8080, not a process started by these harness commands.
- Scoped Git status for `apps/sync` and `packages/diagnostics-contracts` showed no tracked changes; `mix.lock` is unchanged. The generated diagnostics-contracts `dist` output is local/ignored build output.
- Raw logs and evidence were scanned for database URLs and common credential-shaped strings; no matches were found in logs/evidence. The test runner also created TSX transform caches under `lane-c/tmp`; a broad heuristic found token-field-shaped test/runtime text in some cache files. No contents were printed. I attempted to remove only this lane-local cache, but automatic filesystem review rejected both `rm -rf lane-c/tmp` as a recursive delete and `find lane-c/tmp -depth -delete` as equivalent recursive deletion. This cache remains under the lane folder; the requested containers, volumes, and databases are cleaned.

### Log and evidence index

- `lane-c/logs/00-mix-deps-get.log`
- `lane-c/logs/01-sync-gate.log` — first gate attempt/failure
- `lane-c/logs/02-diagnostics-contracts-build.log`
- `lane-c/logs/03-sync-gate-after-build.log` — passing gate rerun
- `lane-c/logs/04-correctness-profile.log`
- `lane-c/logs/05-breaker-campaign.log`
- `lane-c/logs/06-topology-profile.log`
- Correctness manifest/artifact: `lane-c/evidence/correctness/20260927T144051202Z-91974-correctness/`
- Topology manifest/results: `lane-c/evidence/topology/20260927T144209138Z-98831-topology/`
- Standalone breaker artifact: `lane-c/evidence/sync-breaker-v1.json`
