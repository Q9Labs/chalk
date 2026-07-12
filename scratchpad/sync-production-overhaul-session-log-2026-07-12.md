# Sync Production Overhaul Session Log

## 2026-07-12 00:27 PKT

- Started the approved production overhaul from `scratchpad/sync-production-readiness-spec-2026-07-11.md`.
- Confirmed scope: PostgreSQL authority, protocol v2, API lifecycle integration, TypeScript runtime, bounded recovery and delivery, multi-node and failover proof, and a failure-first report.
- Confirmed operating boundary: local environments only; no push and no production access.
- Read the repository, sync, API, and global implementation instructions. Preserving unrelated worktree changes.
- Began the current-state mapping milestone before modifying runtime code.

## 2026-07-12 00:31 PKT

- Moved implementation onto dedicated worktree `/Users/macmini/code/chalk-sync-production-overhaul` on branch `codex/sync-production-overhaul` at commit `641004f5`.
- Confirmed the approved readiness spec and its prior commit are already in this branch's ancestry.
- Stopped all work in the shared `/Users/macmini/code/chalk` checkout.

## 2026-07-12 00:36 PKT

- Completed read-only implementation maps for the Elixir server, API lifecycle, protocol/codegen, and TypeScript SDK surfaces.
- Confirmed the six deterministic breaker failures and assigned the five durable-core failures to Phase 1; bounded slow-client delivery remains the Phase 2 exit condition.
- Started an isolated PostgreSQL 18.3 container on localhost port `56432` with a dedicated database and applied the current migration baseline successfully.
- Verified Postgrex `0.22.2` as the current maintained release and retained the specification's direct-Postgrex decision.
- Started disjoint schema, v2 contract/codegen, and pure TypeScript runtime implementation tracks. The primary thread owns the Elixir reducer and durable command path.

## 2026-07-12 01:01 PKT

- Added a total Session reducer, canonical control projection/digest, UUID boundary, semantic Stateholder types, and deterministic Memory conformance adapter.
- Converted the Memory semantics from a 256-entry process cache to stable per-Session receipts and verified commit, rejection, command-ID conflict, generation retry, recovery digest, and Session isolation behavior.
- Added Postgrex `0.22.3`, explicit database URL parsing, bounded connection supervision, and production configuration that selects the Postgres adapter.
- Implemented the locked PostgreSQL command transaction: receipt-first resolution, product lifecycle validation, atomic event/fold/revision/receipt commit, transaction-local deadlines and synchronous commit, capacity counters, and disposable head notification.
- Added consistent Postgres recovery reads with digest-aware up-to-date, replay, and snapshot decisions.
- Ran six real-Postgres transaction tests green. They prove atomic commit, independent fold equivalence, durable receipts past 300 intervening IDs, connection-set restart recovery, unknown-COMMIT resolution, pre-COMMIT rollback and safe retry, stable rejection/conflict outcomes, and concurrent decisions from two independent node connection sets.
- Cleaned all isolated test fixtures after verification; no shared or production database was touched.

## 2026-07-12 01:24 PKT

- Added a strict protocol-v2 boundary that rejects oversized frames before JSON decoding, converts cursors to binary digests, emits validated snapshot/replay/terminal recovery frames, enforces replay-page bounds, and keeps terminal ACKs separate from retryable infrastructure uncertainty.
- Added five focused protocol-v2 tests; all passed.

## 2026-07-12 01:35 PKT

- Started the bounded per-socket outbound ETS queue slice. The queue will keep encoded payloads out of process mailboxes, enforce the declared event, byte, age, and replay-page limits, and reject off-owner operations through a serialized socket-coordinator ownership boundary.

## 2026-07-12 01:36 PKT

- Completed the bounded outbound queue module and focused tests. The single-writer queue stores only encoded frames and safe revision/replay metadata in private ETS, clears its ETS tables on close or any local overflow, and leaves sockets outside the overflowing queue unaffected.
- Verified formatting and the focused suite: 10 tests pass for FIFO behavior, exact event/byte/page bounds, age expiry with an injected monotonic clock, accounting, cleanup, mailbox isolation, and concurrent off-owner mutation rejection.

## 2026-07-12 01:50 PKT

- Added the API lifecycle transaction core and migration-backed intent ledger for Session creation, participant admission and removal, and Session end. The API and sync application paths share the Session control lock, preserve lifecycle capacity, use synchronous commit, and apply intents idempotently.
- Added the strict v2 TypeScript runtime with canonical replica state, optimistic pending commands, stable retry IDs, browser WebSocket and IndexedDB adapters, bounded diagnostics, and focused package verification.
- Added node-local Session coordinators, bounded command admission, supervised decision tasks, periodic authoritative head repair, and coalesced socket wake-ups. A non-reading socket is now disconnected at exactly 256 queued events while a healthy peer reaches revision 258 and Postgres/Memory remains authoritative.
- Added the PostgreSQL notification listener. A real-Postgres test proved that a coordinator which performed no local publish catches up from a transactional notification, while malformed notifications are discarded without affecting the listener.
- Changed v2 socket recovery to a real `recovering` phase. Recovery frames are handed to the WebSocket one callback at a time, live wake-ups are held until `recovery_complete` is emitted, and two missed 20-second heartbeat deadlines close the socket.
- Ran the complete sync test suite against the isolated PostgreSQL 18.3 database: 145 tests passed with zero failures. Expected fault-injection logs confirmed lost-COMMIT resolution and pre-COMMIT rollback paths were exercised.

## 2026-07-12 02:12 PKT

- Added dependency-aware readiness with writable-primary, exact migration, synchronous-commit, optional synchronous-standby/WAL-lag, lifecycle-lag, listener, coordinator-supervisor, and command-admission observations. Two failures remove readiness; recovery requires successful probes spanning five seconds.
- Added graceful drain. New upgrades and commands stop immediately, accepted decision tasks receive their bounded completion window, coordinator queues drain in order, and sockets close with retryable 1012 semantics. Production configuration disables v1 and refuses Memory, the development verifier, a missing launch WAL-lag ceiling, or failed boot observations.
- Added low-cardinality ETS-backed telemetry aggregation and `/metrics`. The handler retains only fixed event/outcome counters and numeric duration/byte totals; tokens, participant names, payload bodies, and customer identifiers are excluded.
- Enforced the 500-participant limit in both reducer event application and snapshot decoding.
- Added an actual independent-node integration proof. Two unclustered BEAM OS processes accepted concurrent commands for one Session through separate v2 listeners, converged through PostgreSQL notifications, retained one revision order, survived one node death, accepted another command on the remaining node, and restored the killed node at authoritative revision 5. The independent event fold matched the stored snapshot and exactly three receipts existed.
- Fixed the external-node test cleanup after the first run exposed orphaned child BEAM processes. The harness now records and terminates the actual BEAM PID, explicitly stops every node, and leaves no `sync-node-local.exs` process behind.
- Re-ran the complete real-Postgres sync suite after operations work: 156 tests passed with zero failures. The independent-node proof also passed in isolation after cleanup hardening.

[2026-07-12 02:23:16 PKT] Started review of all staged, unstaged, and untracked production-overhaul changes; running required codex review and targeted validation.

## 2026-07-12 02:41 PKT

- Added bounded retention scheduling and readiness observations. Cleanup verifies the final fold and checkpoint, deletes with `SKIP LOCKED` in bounded batches after seven days, and reports cleanup lag without hiding worker failure.
- Applied migration `20260712154500` and populated the exact launch-cardinality fixture: 500 participants, 250,000 events, and 500,000 durable receipts. PostgreSQL used the intended primary-key indexes for receipt lookup and bounded recovery suffix reads.
- Converted the v2 breaker runner, verifier, Memory history, and trace writer away from quadratic list growth. A deterministic 10,000-command Memory campaign passed and replayed from its complete trace artifact.
- Ran a real-PostgreSQL 1,000-command campaign with a lost post-COMMIT response, plus all nine transaction fault checkpoints and a rejected-receipt insertion fault. Every campaign converged and every saved artifact replayed successfully.
- Proved two TypeScript recovery surfaces against the real Elixir v2 server and PostgreSQL. Chromium connected and converged through the browser adapter; a Node process persisted a pending command, terminated, and a second process loaded, retried, committed, converged, and cleared the store.
- Added unique release artifact generation with a versioned manifest and SHA-256 hashes. The release booted on localhost, passed health, readiness, and metrics probes against the migrated database, and stopped on SIGTERM. Production boot continues to require an external token verifier, a synchronous standby, and an explicit WAL-lag ceiling; the localhost-only proof exception is explicit and cannot accept a remote database.
- Rewrote sync ownership and protocol documentation around PostgreSQL authority and protocol v2.
- A true TCP slow-reader test exposed an unproven boundary: the operating system absorbed 2,000 small frames without forcing the non-reading peer to disconnect. The current test is being strengthened with maximum-size schema-valid live frames to locate the real transport bound before declaring this exit condition satisfied.
- The maximum 100,000-command Memory campaign remains active. Its process is healthy, CPU-bound, and within a bounded memory footprint while the deterministic trace is generated.

## 2026-07-12 03:31 PKT

- Added protocol-v2 cumulative live delivery acknowledgements. TypeScript replicas acknowledge only successfully reduced canonical live revisions and their digests; replay pages remain outside this acknowledgement path.
- Changed each outbound queue to retain sent live frames as in-flight until the client acknowledges the exact revision and digest. Event, byte, and age limits now cover queued and in-flight delivery, so kernel and WebSocket buffering cannot hide a non-reading peer.
- Proved the real TCP boundary: a non-reading peer is disconnected on the 257th outstanding live event, while an acknowledging peer remains connected and applies another 20 revisions. The complete PostgreSQL socket suite, focused protocol/queue/coordinator suites, browser recovery proof, Node restart proof, and independent two-node proof pass with delivery acknowledgements enabled.
- Ran the complete sync gate against PostgreSQL: 175 tests passed, formatting passed, and strict Credo passed. Ran the complete API gate: tests, smoke coverage, vet, staticcheck, and govulncheck passed. TypeScript code generation, 24 client tests, lint, build, and generated-file checks passed.
- The repository Fallow audit passes. The repository health sub-gate currently reports 88.9 against the required score of 90. The remaining work is to reduce the new sync runtime's measured structural risk without weakening the gate.
- The bounded 100,000-operation deterministic Memory campaign remains active and healthy; its trace writer finalizes the artifact only after the campaign completes.

## 2026-07-12 03:15 PKT

- Completed the maximum bounded Memory campaign: 100,000 operations across 16 sessions, 64 participants, and 128 simulated sockets passed. The independent replay of the complete 87 MB JSONL trace also passed and reconstructed all 16 sessions.
- Rebuilt the production OTP release from the current implementation. The uniquely named artifact booted against the migrated local PostgreSQL database, bound only to localhost, returned successful health, dependency-aware readiness, and metrics responses, and stopped cleanly on SIGTERM with its listener removed.
- Confirmed that the Fallow health shortfall predates the sync work. The unchanged branch scores 89.1/90 because the intentionally complexity-suppressed `WhiteboardCanvasBase` remains one greater-than-60-line unit. The new TypeScript sync client scores 100 when analyzed as its own workspace and introduces no oversized unit. A bounded behavior-preserving extraction is in progress so the repository gate can pass without an ignore or lower threshold.

## 2026-07-12 03:30 PKT

- A production-readiness audit found three implementation defects behind otherwise green focused tests: recovery eagerly materialized all replay pages, API Session creation lacked a durable request-idempotency ledger for unknown commit results, and the TypeScript test-presence gate could not associate an aggregate suite with fourteen runtime modules. All three are being corrected without weakening a gate.
- Fixed a client restart edge case in which a command already represented by a recovered snapshot could remain pending forever when the retry received only a duplicate ACK. The runtime now settles that persisted command when the authoritative revision is already present, and a focused regression passes.
- Tightened database readiness to require PostgreSQL 18 or later with `fsync`, `full_page_writes`, and data checksums enabled, and to accept only `on` or `remote_apply` transaction-effective synchronous commit. Added pure positive and negative probe assertions.
- Bounded API lifecycle transactions with a 750 ms lock timeout, two-second statement timeout, three-second transaction timeout, and transaction-effective synchronous commit. Real-Postgres adapter tests pass with these settings.
- Made release artifact generation reject a dirty worktree before packaging. A clean-build proof remains intentionally deferred until the verified implementation is committed.
- Refactored the pre-existing whiteboard health hotspot without suppressions or threshold changes. Its eleven tests, formatting, type checking, and package build pass. The global health gate will be rerun only after concurrent TypeScript test reorganization is quiescent; an interim run during those edits scored 88.6 and is not accepted evidence.
- The audit also confirmed four external acceptance blockers: no production token issuer/verifier integration is present, no approved launch envelope exists for the 60-minute load and eight-hour soak gates, no synchronous-standby promotion or PITR topology is available locally, and migration of populated legacy Sessions needs an explicit backfill or a verified-empty target. These remain visible in the final binary verdict.

- 2026-07-12 03:31:17 PKT Review session started: inspecting all staged, unstaged, and untracked changes; running the repository-mandated Codex review.

[2026-07-12 03:41:42 PKT] Review verification: sync gate passed; API tests/vet passed but API gate stopped at govulncheck due a missing shared Go cache entry; client tests and typecheck passed; identified production boot-order, migration-version, lifecycle polling, and pending-store retry defects.

## 2026-07-12 03:46 PKT

- Started the bounded API Session-create idempotency correction. The work isolates the durable HTTP-semantic fingerprint from server-owned control defaults, adds exact JSON number normalization, and verifies ambiguous post-COMMIT recovery against the local PostgreSQL lifecycle database.

## 2026-07-12 03:52 PKT

- Completed the Session-create idempotency correction. The versioned `session-create/v1` fingerprint contains only tenant, room, canonical metadata, actor, and started-at values. It excludes generated Session IDs and server-owned initial-control defaults.
- Added lossless exact JSON numeric normalization. Equivalent integer, decimal, and exponent spellings now share a fingerprint across nested objects and arrays while adjacent large exact values remain distinct.
- Added PostgreSQL proofs for changed control defaults, an ambiguous post-COMMIT response, and concurrent reuse of one key with distinct semantic fingerprints. Each proof preserves exactly one durable Session, control row, and create ledger row.
- Verified `go test -count=1 ./internal/sessionlifecycle ./internal/adapters/postgres ./internal/httpapi` against `CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:56432/chalk_sync_overhaul?sslmode=disable`; all packages passed. `gofmt -d` and `git diff --check` returned no output.

[2026-07-12 04:05:21 PKT] Started review of all staged, unstaged, and untracked changes; inspecting API, sync, codegen, and whiteboard behavior.

## 2026-07-12 04:20 PKT

- Added protocol-v2 `recovery_ack` across the contract, generators, Elixir server, TypeScript client, and real-wire helpers. Snapshot and replay frames now retain queue byte, page, and age reservations until the client confirms the exact recovery ID, applied revision, and digest.
- Proved that recovery does not fetch the next page before acknowledgement, wrong acknowledgements fail closed, valid snapshot and replay frames above 64 KiB reach the client, and an unacknowledged recovery frame expires near five seconds while a healthy peer continues.
- Corrected Session-create idempotency generation so all four lifecycle SDK endpoints expose the required constrained `Idempotency-Key` header. Canonical generation and drift checks pass.
- Corrected three additional review findings: command transactions no longer accept `remote_write`, failed lifecycle pages no longer repoll at zero delay, and a failed client pending-store load can be retried safely on the next start.
- Made OpenAPI generation canonical and atomic. A forced generator failure preserved the prior artifact SHA-256 and left no temporary files; successful standalone generation matches the canonical SDK drift check.
- Made duration-based breaker campaigns truthful. They derive the required operation count with ceiling arithmetic, reject an insufficient command budget, wait through the requested deadline, and accept an explicitly bounded eight-hour low-rate configuration.
- The first integrated sync gate exposed a global trace-order race. Replaced the ten-message guess with a unique Room-correlated trace assertion; it passed 30 consecutive repetitions and the complete gate then passed 193 tests with zero failures.
- The API gate passed all tests, lifecycle smoke, vet, Staticcheck, and vulnerability scanning. Client verification passed 41 tests, formatting, types, and build. Contract code generation passed drift checking, 24 tests, and lint. Fallow health passed 90/90 and test-presence passed for 18 new sources.
- Re-ran real Chromium recovery, Node process-restart recovery, the independent two-node process proof, the real slow-TCP bound, and the recovery-age bound; every focused proof passed.
- Re-ran ten local-Postgres breaker campaigns for the no-fault case and all nine transaction checkpoints. All campaigns and all independent artifact replays passed. The earlier pool-saturation artifact remains retained as a failure; its exact post-commit reproducer passed under a quiescent pool.
- Rewrote the readiness specification around the implemented local state and wrote the failure-first production report. The binary release verdict remains not production-ready because production token integration, populated-data migration, synchronous standby promotion/PITR, and the approved load/soak envelope remain unavailable.

## 2026-07-12 04:27 PKT

- The full changed-file Fallow audit initially failed with 30 complexity findings and two duplicate groups across the new TypeScript sync runtime and the extracted whiteboard component.
- Refactored storage validation, codec conversion, canonicalization, client lifecycle and acknowledgement paths, reducer validation, browser construction, and whiteboard configuration into bounded units without changing thresholds, ignores, or suppressions.
- The changed-file audit now passes with no findings across 284 changed files. The client and whiteboard packages pass 54 focused tests, formatting, type checking, and lint after the refactor.

## 2026-07-12 04:51 PKT

- The independent repository review found five correctness and operability defects: synchronous readiness probes blocked cached health, retention cleanup blocked its health process, failed lifecycle intents could pin the discovery page, browser lifecycle state was not initialized, and a stopped asynchronous client start could install a stale subscription.
- Moved readiness probes and retention cleanup into monitored workers with no-overlap, stale-result, and shutdown guards. Cached health stays responsive while either dependency operation is blocked.
- Added durable lifecycle retry scheduling. Failed intents atomically record their error, advance a saturating attempt counter, and receive an exponential database deadline from 100 milliseconds through a 30-second cap. Due-time ordering lets new and eligible work advance beyond poisoned pages without a database retry storm.
- Added current browser online/visibility initialization and generation-safe shared pending-store startup. An offline hidden client opens no socket, a stopped load installs no listener, and a later start owns exactly one subscription.
- Applied migration `20260712180000` to the isolated PostgreSQL 18.3 database. Sixteen focused Elixir/Postgres tests, thirteen focused client tests, and the three affected API packages passed after the fixes. The full non-security gates and a second independent review remain pending.

## 2026-07-12 05:03 PKT

- The final independent review found three functional client defects: concurrent sends could pass capacity checks before persistence completed, a settled command could remain pending after a transient removal failure, and token refresh could not recover a `rejoin_required` client.
- Reserved count and byte capacity synchronously before pending-store writes, retried removal when a settled duplicate acknowledgement returns, and made refresh reconnect a started client after a policy close.
- Excluded the reviewer's TLS certificate-hostname item because cybersecurity review and implementation are outside the authorized scope. This is the final independent review; focused regression tests and the final non-security verification remain pending.

## 2026-07-12 05:09 PKT

- Completed the final non-security workspace verification. Hygiene, changed-file Fallow, Fallow health, generated-contract drift, dependency alignment, test presence, formatting, type checking, lint, unit tests, coverage, builds, package publishing checks, package type-resolution checks, and whitespace validation passed.
- The TypeScript client completed 49 tests across 18 files. The full workspace test and coverage tasks completed successfully, and Fallow reported no changed-file findings with an A health score of 90.
- Package publishing checks reported only advisory repository URL and Node engine suggestions; package type-resolution checks reported no problems.
- Updated the production-readiness report with all eight functional defects found by the two final reviews and their verified dispositions. No further review cycle will run.

## 2026-07-12 05:30 PKT

- The clean 100,000-operation campaign failed at final verification with `revision_order_or_convergence=:snapshot`. Preserved the complete 300,002-line artifact under commit `f2a8e61f` and streamed every record before changing code.
- The complete trace contained 100,000 valid decision/retry/conflict groups, contiguous committed revisions for all 16 Sessions, stable duplicate outcomes, correct command-ID conflicts, and no malformed record. Every Session crossed 3,000 committed revisions.
- Located the defect in the breaker verifier. Revision-zero recovery correctly selected a snapshot after the bounded 2,048-event replay limit, while the verifier required replay mode and stopped before comparing any snapshot field. Failed artifacts from that path also lacked event and final-head records, so independent replay reported `:missing_final_head`.
- Changed verification to audit the complete persisted event stream through bounded recovery pages, retain event and final-head evidence before convergence checks, validate the independent fold against the recovery head and snapshot, and then exercise snapshot/replay replica convergence.
- Added a deterministic 2,051-event snapshot-boundary regression. The regression and focused artifact suites passed, and an exact 5,000-command boundary campaign passed with an independently passing replay.
- Re-ran the canonical sync gate against PostgreSQL: formatting, warnings-as-errors compilation, strict Credo, and 201 tests passed with zero failures.
