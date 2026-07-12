# Chalk Sync Production Readiness Report

**Verdict:** NOT PRODUCTION READY
**Implementation state:** Local durable-core implementation complete
**Evidence date:** 2026-07-12
**Scope:** Sync correctness, lifecycle integration, recovery, bounded delivery,
client convergence, operations, and non-security stress testing

Cybersecurity assessment and implementation are excluded by request.

## Release blockers

| Blocker                       | Current evidence                                                                                                                                                                                  | Acceptance required                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Production token integration  | The release defines the verifier boundary, while local wire proofs use the development verifier. No production issuer/verifier adapter is wired.                                                  | Exercise a real issued token through the production verifier and v2 route in the release configuration.                               |
| Database failover and restore | Every database proof uses one local PostgreSQL 18.3 primary. No synchronous standby or restore target exists in the available environment.                                                        | Promote a synchronous standby under acknowledged writes, verify every receipt/event/fold, and restore an isolated point-in-time copy. |
| Existing-data migration       | Migration `20260712113000` aborts when legacy `room_sessions` or `participants` contain rows because their v2 fold and digest cannot be inferred safely.                                          | Approve and verify an empty target or implement, review, and rehearse an explicit backfill.                                           |
| Launch load and soak          | The harness can enforce an eight-hour duration at an explicit rate, but Chalk has no approved launch concurrency/rate envelope. No 60-minute peak-plus-30-percent run or eight-hour soak has run. | Approve the launch envelope, run both campaigns against the release topology, and retain passing artifacts.                           |
| Integrated failure schedules  | Notification loss, process restart, and non-local database failure are covered by focused or externally orchestrated proofs. The breaker CLI does not yet compose those schedules itself.         | Add first-class schedules or run an approved external orchestration plan against the release topology and retain passing artifacts.   |

Production deployment was outside this work and was not attempted.

## What exists now

Chalk has a concrete sync protocol. The language-neutral source is
[`contract/schema/sync-v2.json`](../contract/schema/sync-v2.json). Generated
Elixir and TypeScript validators reject unknown shapes and enforce byte,
revision, identity, and recovery bounds.

Postgres is the durable source of truth for Session control state, the ordered
event log, command receipts, participant-session lifecycle, and lifecycle
intents. Redis is neither required nor used for durable correctness. PostgreSQL
notifications are disposable head hints, and periodic authoritative reads
repair missed hints.

BEAM coordinators own disposable subscriptions and bounded encoded-frame
queues. A live event remains reserved until a cumulative `delivery_ack` matches
its applied revision and digest. A snapshot or replay page remains reserved
until an exact `recovery_ack` matches its recovery ID, revision, and digest.
The next replay page is not fetched before that acknowledgement. A peer that
does not acknowledge is disconnected after the five-second queue age bound.

The TypeScript package contains the canonical reducer, recovery state machine,
pending-command overlay, browser IndexedDB adapter, React Native persistence
seams, retry/backoff logic, diagnostics, v2 codec, and WebSocket runtime.

## Correctness findings and disposition

| Finding                                                                                          | Disposition                                                                                                                       | Proof                                                                             |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Writer restart lost outcomes                                                                     | Fixed with durable receipts.                                                                                                      | Real-Postgres restart and receipt tests.                                          |
| Old IDs were forgotten after 256 outcomes                                                        | Fixed; receipts remain authoritative for the active Session.                                                                      | More-than-300-receipt regression and 100,000-operation model run.                 |
| Commit could succeed while the caller saw a false rejection                                      | Fixed; uncertainty resolves by reading the receipt.                                                                               | `after_commit_before_reply` campaign and ambiguous API `COMMIT` test.             |
| Revision conflict could leave an empty writer                                                    | Fixed by disposable coordinators and Postgres authority.                                                                          | Breaker regression and restart tests.                                             |
| Non-reading subscribers were unbounded                                                           | Fixed for live delivery with retained in-flight queue reservations.                                                               | Real slow-TCP peer test at the 256-event bound.                                   |
| Recovery pages escaped queue accounting after transport push                                     | Fixed with exact recovery acknowledgements.                                                                                       | Snapshot/page gating, wrong-ACK, and five-second expiry tests.                    |
| Reducer accepted a non-exact revision                                                            | Fixed in reducer and database constraints.                                                                                        | Exact-next reducer and real-Postgres tests.                                       |
| Recovery eagerly materialized a complete suffix                                                  | Fixed with demand-paged reads through a fixed head.                                                                               | Two-page recovery tests and Postgres wire recovery.                               |
| TypeScript rejected valid recovery frames above 64 KiB                                           | Fixed; valid replay pages and snapshot welcomes use their generated limits.                                                       | Greater-than-64-KiB replay and snapshot client regressions.                       |
| Complete replay byte accounting counted page envelopes                                           | Fixed; total accounting sums standalone encoded events while each page retains its full-frame limit.                              | Near-two-MiB recovery accounting regression.                                      |
| Session create retry lacked a durable request ledger                                             | Fixed with `session_create_requests` and required `Idempotency-Key`.                                                              | Concurrent conflict and ambiguous-commit real-Postgres tests.                     |
| Session create fingerprints depended on generated IDs and server defaults                        | Fixed with versioned semantic `session-create/v1` fingerprints.                                                                   | Changed-default and same-intent retry regressions.                                |
| JSON numeric spellings could produce different fingerprints                                      | Fixed with lossless exact normalization.                                                                                          | Nested, array, exponent, and large-integer tests.                                 |
| Generated Effect endpoints omitted required headers                                              | Fixed with generic request-header generation.                                                                                     | Four lifecycle header goldens and canonical regeneration check.                   |
| Memory historical recovery trusted only revision                                                 | Fixed; historical cursors also verify schema and digest.                                                                          | Correct, wrong-digest, and wrong-schema regressions.                              |
| Command transactions accepted PostgreSQL `remote_write` despite the declared durability contract | Fixed; transactions accept only `on` or `remote_apply`.                                                                           | Focused synchronous-commit setting regression.                                    |
| A full page of retrying lifecycle intents could poll with zero delay                             | Fixed; any failed page waits for the configured poll interval.                                                                    | Lifecycle poll-delay regression.                                                  |
| A failed pending-store load made the next client start skip durable work                         | Fixed; the store is marked loaded only after a successful load and normalization.                                                 | Fail-once, restart, and recovered-command regression.                             |
| Failed OpenAPI generation could truncate the tracked contract                                    | Fixed with a temporary directory, canonical formatting, and atomic rename.                                                        | Forced generator failure preserved the prior SHA-256 and left no temporary files. |
| Breaker `duration_ms` could silently run shorter and could not represent eight hours             | Fixed with ceiling-derived operation counts, command-budget validation, an enforced minimum deadline, and an eight-hour cap.      | Timing-seam tests and a real 500 ms duration campaign.                            |
| Trace test depended on the first ten global events                                               | Fixed with a unique Room-correlated event and deadline.                                                                           | Full sync gate and 30 consecutive focused repetitions.                            |
| Readiness dependency probes blocked cached health reads                                          | Fixed with monitored, non-overlapping probe workers and stale-result guards.                                                      | Slow-probe and shutdown regressions plus the complete sync gate.                  |
| Retention cleanup blocked its health process                                                     | Fixed by moving cleanup into a monitored worker with no-overlap and shutdown guards.                                              | Blocked-cleanup health and worker-lifecycle regressions.                          |
| Failed lifecycle intents could pin the discovery page                                            | Fixed with durable due-time scheduling, saturating attempts, and bounded exponential retry deadlines.                             | Poison-intent starvation and retry-deadline Postgres regressions.                 |
| Browser lifecycle state was unknown until the first event                                        | Fixed by initializing online and visibility state from the current browser document.                                              | Initially offline and hidden browser regressions.                                 |
| A stopped asynchronous client start could install a stale subscription                           | Fixed with generation-safe startup ownership and listener cleanup.                                                                | Stop-during-load and subsequent-start regressions.                                |
| Concurrent client sends could overrun pending count or byte capacity                             | Fixed by reserving both limits synchronously before durable pending-store writes.                                                 | Concurrent count-capacity and byte-capacity regressions.                          |
| A transient pending-store removal failure could leave a settled command stuck                    | Fixed by retrying durable removal when a duplicate acknowledgement proves the command is settled.                                 | Fail-once removal and duplicate-acknowledgement regression.                       |
| Token refresh could not recover a client closed with `rejoin_required`                           | Fixed by resetting the started client to idle and reconnecting with the refreshed token.                                          | Policy-close refresh and reconnect regression.                                    |
| Breaker treated required snapshot fallback above 2,048 replay events as divergence               | Fixed by auditing the complete persisted event stream in bounded pages before validating snapshot, head, and replica convergence. | A 2,051-event boundary regression plus a 5,000-command campaign and replay.       |

## Executed evidence

| Surface                        | Result                                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Canonical sync gate            | 200 tests, zero failures; format, warnings-as-errors compile, and strict Credo passed.                                                                                                        |
| Canonical API verification     | All Go tests, lifecycle smoke test, `go vet`, and Staticcheck passed. The security phase was outside the authorized scope.                                                                    |
| Real-Postgres API lifecycle    | `sessionlifecycle`, Postgres adapter, and HTTP integration packages passed against migration `20260712180000`.                                                                                |
| TypeScript client              | 18 files and 49 tests passed; formatting, type check, lint, and browser build passed.                                                                                                         |
| Contract generation            | Generated drift check passed; 24 contract-codegen tests and package lint passed.                                                                                                              |
| Repository non-security gate   | Hygiene, Fallow, contract drift, dependency alignment, test presence, formatting, types, lint, tests, coverage, builds, package publishing checks, and package type-resolution checks passed. |
| Repository static health       | Fallow reported no changed-file findings and an A health score of 90; test presence passed for 19 new meaningful source files.                                                                |
| Real browser                   | Headless Chromium completed v2 snapshot recovery and reached revision 2 against the real local server and Postgres.                                                                           |
| Client process restart         | A Node process persisted a command; a second process loaded, retried, committed, converged, and cleared it at revision 2.                                                                     |
| Independent nodes              | Two unclustered BEAM OS processes shared one Postgres order, survived one node loss, and restored the stopped node.                                                                           |
| Delivery bounds                | A non-reading real TCP peer was disconnected at the live bound while a healthy peer advanced; an unacknowledged recovery frame expired near five seconds while a healthy peer continued.      |
| Transaction fault matrix       | `none` plus nine transaction checkpoints passed in ten Postgres campaigns; independent replay passed for every artifact.                                                                      |
| Session-create trace           | The real route returned 201 and traced the bounded transaction, durable request reservation, Session row, control row, and commit.                                                            |
| Large deterministic model      | 100,000 operations across 16 modeled Sessions, 64 participants, and 128 modeled socket replicas passed and replayed from the complete trace.                                                  |
| Launch cardinality query proof | The local fixture populated 500 participants, 250,000 events, and 500,000 receipts and exercised the intended indexes. This is query/cardinality evidence, not a durability or failover run.  |

The 100,000-operation artifact is
`apps/sync/.artifacts/sync/641004f51588/seed-2026071203-1783804771122-1`.
The integrated Postgres fault artifacts are the ten runs with seeds
`20260720` through `20260729` under
`apps/sync/.artifacts/sync/641004f51588/`.

The `sockets` and `subscriptions` fields in breaker manifests describe modeled
replica dimensions. They are not counts of real TCP connections. The real
slow-peer evidence uses two actual WebSocket peers.

## Saved failure

The clean 100,000-operation artifact
`apps/sync/.artifacts/sync/f2a8e61f1887/seed-2026071205-1783815080385-1`
failed at final verification with `:snapshot`. A complete streaming analysis of
all 300,002 JSONL lines found 100,000 valid decision/retry/conflict groups,
contiguous committed revisions for every Session, and no malformed record. All
16 Sessions legitimately exceeded the protocol's 2,048-event complete-replay
limit, so revision-zero recovery returned a snapshot. The verifier incorrectly
required replay mode and stopped before comparing any snapshot field. The
artifact replay consequently reports `:missing_final_head`; this is retained as
the reproducer for the verifier defect and is not evidence of an engine
divergence. The corrected 5,000-command boundary campaign passed and replayed at
`apps/sync/.artifacts/sync/f2a8e61f1887/seed-2026071205-1783816047182-1`.

The failed trace SHA-256 is
`252833395b03eddddafa6aa36c9a9046764922864e1471d91ce9f7b259e012f3`.

The artifact
`apps/sync/.artifacts/sync/641004f51588/seed-20260713-1783803700674-1`
failed before its first trace record because a database pool request waited
5,987 ms and was dropped while concurrent local work was using the database.
The exact 12-command `after_commit_before_reply` reproducer passed under a
quiescent pool at
`apps/sync/.artifacts/sync/641004f51588/seed-20260713-1783811225406-1`,
and its independent replay passed. The failed artifact remains retained and is
not counted as release evidence.

## Evidence boundaries

- All PostgreSQL evidence uses one local primary. It cannot establish standby
  acknowledgement, promotion behavior, WAL-loss bounds, or restore integrity.
- The independent-node, browser, and Node proofs run in test configuration and
  use the development verifier. They establish sync behavior, not production
  token integration.
- Notification loss and node loss have focused tests. The breaker CLI still
  rejects notification, restart, and non-local database schedule names rather
  than claiming unsupported coverage.
- No launch-rate claim is possible without the approved envelope. The harness
  now represents an eight-hour low-rate campaign honestly, but it has not run
  that acceptance test.
- The checked-in migration supports a verified-empty v2 launch database. It is
  intentionally unsafe to apply over unexplained legacy lifecycle rows.

## Plain-language assessment

The sync logic is robust under the local failures we can create. It keeps one
durable order, survives process and node restarts, resolves uncertain commits,
reconnects clients without gaps, and cuts off slow peers within declared
bounds.

The production system is not ready to launch today. The remaining work is
deployment evidence and integration that the local environment cannot supply:
the real token adapter, a safe legacy-data decision, synchronous database
failover and restore, the approved load and soak runs, and integrated failure
schedule evidence against the release topology. Launching before those five
items pass would make the durability promise unverified.
