# Sync engine test harness analysis session log

## 2026-07-30 18:24 PKT

- Started a read-only analysis of the SyncEngine test harnesses, their gate and CI integration, and the confidence they earn for correctness and reliability.
- Read the repository writing guide, Sync-specific `AGENTS.md`, Sync README, v3 breaker overview, Mix project, and focused gate.
- Confirmed the worktree already contains unrelated SDK and scratchpad changes; this analysis will leave them untouched.

## 2026-07-30 18:45 PKT

- Mapped 95 Sync test files containing 450 test declarations, the legacy v1/in-memory breaker, the deterministic v3/PostgreSQL breaker, real-WebSocket fixtures, cross-runtime SDK proofs, and the external release-topology scheduler.
- Confirmed the root smart gate always sets `CHALK_SYNC_GATE_MODE=basic` for Sync, including scheduled `--full` CI, so CI stops after dependency, format, and warnings-as-errors compilation instead of running Credo or ExUnit.
- Confirmed a direct `mix test` without a database exits successfully with 344 passing and 106 skipped tests. With a migrated PostgreSQL 18.4 database, the suite completed with 449 passing and one skipped opt-in provider-bridge mTLS test.
- The current full Sync gate is not green: Credo stopped it with one complexity finding, three single-clause `with` readability findings, and one nested-module alias finding before ExUnit ran.
- Ran `mix sync.breaker.v3` against migrated PostgreSQL: the fresh 37-schedule campaign passed, wrote a 20,205-byte checksummed artifact, and replayed twice with identical semantic projections.
- Ran the legacy default breaker: it exited 1 with 11 passing and 14 failing scenarios. Its failures are deliberate diagnostics against the production-disabled v1/in-memory path, including eight random-wire idempotency failures and six focused legacy defects.
- Ran the production TypeScript SDK Node restart proof end to end: one pending v3 target survived a SIGKILL and converged to revision 2 after process restart.
- Validated the release-topology fixture in dry-run mode. The repository contains the scheduler framework and one single-event dry-run fixture, but no checked-in executable local/staging campaign proving the documented seven failure classes.
- The real Chromium proof remains unverified. The verifier lacked Playwright Chromium build 1208; the local installer downloaded 162.3 MiB but stalled with an incomplete 428 KiB cache entry, so the proof never launched Chromium.
- Stopped every PostgreSQL/container/BEAM process started for verification, removed the remote temporary project and database cluster, and moved the incomplete 428 KiB Playwright cache entry to Trash.

## 2026-07-30 19:10 PKT

- Confirmed the current production Sync route is `/v3/sync`; its modern tests compile the current working-tree modules and exercise `SocketV3`, while the legacy breaker still targets the disabled `/v1/sync` compatibility path.
- Confirmed whiteboard collaboration is a separate production transport at `/v1/whiteboard`, not part of SyncEngine v3 or the v3 breaker. It has focused protocol, multipart, queue, reducer, PostgreSQL repository, socket-handler, generated-contract, TypeScript client, and whiteboard package tests.
- Found whiteboard server coverage is materially narrower than v3 coverage: its three socket tests call the handler directly rather than opening a real WebSocket, its PostgreSQL repository has one broad integration test, and it has no breaker, real-process restart proof, multi-node proof, partition/failover campaign, or browser end-to-end proof.
- The latest v3 engine and whiteboard tests were introduced or updated alongside their production code in recent commits, but mandatory CI does not run the Sync ExUnit suite. Recent alignment is therefore visible in history, while protection against future test/code drift is weak.
- Confirmed the repository contains an external release-topology scheduler and an unused external-node helper, but no checked-in executable campaign covering the documented multi-node and infrastructure failures.

## 2026-07-30 19:17 PKT

- Generated and shared a high-level architecture diagram showing the current SyncEngine v3, whiteboard transport, and TypeScript SDK flowing through mandatory PR, nightly topology, and soak/load tiers, with a shared correctness oracle and replayable failures gating a trusted release.

## 2026-07-30 19:21 PKT

- Replaced the first diagram because it incorrectly presented test subjects, triggers, test modes, and validation mechanisms as peer architecture components.
- The replacement uses one explicit flow: one release candidate containing the three tested components enters one reliability harness containing three scheduled test modes and shared checks, producing one pass-or-block release decision.

## 2026-07-30 19:48 PKT

- Reworked the diagram again to separate triggers, orchestration, harness mechanics, the release candidate, the isolated test environment, and enforcement.
- Established one proposed shared reliability harness with three profiles selected by an orchestrator: pull requests run fast correctness checks, the nightly cron runs topology failures, and a release candidate runs the full soak/load profile.
- Made enforcement explicit: pull-request failures block merge, nightly failures turn release readiness red, and release-candidate failures block promotion.
- Corrected the final architecture so a release candidate runs all profiles plus soak, and distinguished release-candidate components from the PostgreSQL, node, and network test environment.

## 2026-07-30 20:35 PKT

- Began implementation after approval and created an explicit tracked goal for
  the shared reliability harness.
- Added fail-closed correctness, topology, and release profile orchestration
  with sealed per-commit manifests and exact reproducers.
- Routed Sync pull-request changes through the full PostgreSQL-backed,
  zero-skip suite, v3 breaker, TypeScript Sync/whiteboard tests, and whiteboard
  package tests.
- Added real multi-process Sync topology coverage for cross-node v3 and
  whiteboard convergence, client network partitions, unclean node loss, and
  PostgreSQL 18 primary/standby promotion.
- Fixed whiteboard cross-node transient fanout to use a unique runtime instance
  id; separate OS nodes previously shared `nonode@nohost` and suppressed valid
  cursor events.
- Added a concurrent three-node soak/load profile with command correctness,
  recovery, latency bounds, and structured evidence.
- Added scheduled topology and manual release-candidate CI enforcement, with
  replayable evidence uploaded by commit.
- Moved CPU-intensive topology verification to the M4 Mac mini. The first
  primary-to-standby clone exposed an unbounded checkpoint wait; the wrapper
  now requests a fast checkpoint and cleans up its isolated PostgreSQL pair.

## 2026-07-30 21:37 PKT

- Completed the shared profile runner, strict PR correctness gate, scheduled
  topology workflow, manual release-candidate workflow, and commit-bound
  evidence manifests.
- The real multi-node profile exposed and fixed two production defects:
  non-distributed OS nodes shared the same whiteboard fanout source identity,
  and PostgreSQL notification listeners did not reconnect after primary loss.
- Verified PostgreSQL primary termination and standby promotion, client
  partition and healing, unclean Sync process loss, exact v3 recovery,
  cross-node whiteboard durable and transient fanout, Node process restart, and
  real Chromium recovery on the M4.
- Extended release load from a short burst to a five-minute, 24-client workload.
  Longer execution exposed the expected 1012 recovery and ambiguous-command
  paths, so the harness now reconnects, verifies the authoritative revision,
  and resends the same command idempotently within a bounded retry budget.
- The repository-wide gate is not green outside this scope. After the API and
  Sync correctness gates passed, the existing meeting-broker type check failed
  because `InternalBrowserSessionInput` and `browserSessionId` are absent from
  its contracts.

## 2026-07-30 21:47 PKT

- The final five-minute M4 soak passed with 24 clients across three real Sync
  nodes: 34,104 committed commands, 1,344 bounded delivery recoveries, exact
  final revisions for every client, 113.67 commands/second, 20 ms p95, 35 ms
  p99, and 56 ms maximum latency.
- Final harness checks passed: Actionlint, ShellCheck, Oxfmt, 14 orchestrator
  and smart-gate tests, Elixir formatting, and whitespace validation.
- The five-minute workload kept its isolated PostgreSQL data bounded and
  retained enough disk headroom on the M4 to complete.

## 2026-07-30 22:20 PKT

- Committed the isolated harness change as `test(sync): add reliability
  harness`; unrelated shared-worktree changes remained unstaged.
- The required `codex review` run produced only startup metadata and no findings
  for roughly 27 minutes. It was stopped at Hasan's request and exited 137, so
  review coverage is failed, not green.
- Removed the exact M4 verification copy and confirmed no harness, topology,
  PostgreSQL, Sync-node, or review processes remained.
