# Lifecycle intent starvation review fix session log — 2026-07-12

- 2026-07-12 04:42:50 PKT — Started review of lifecycle intent discovery. The durable intent table already has attempt counters and error codes; the consumer always reselected the first pending page.
- 2026-07-12 04:42:50 PKT — Implemented durable fair ordering by attempt count. Failed lifecycle deliveries atomically advance their durable attempt counter and record the stable error code, while discovery stays lock-free and idempotent.
- 2026-07-12 04:42:50 PKT — Added a durable exponential retry schedule from 100 milliseconds to a 30-second cap. Due work is indexed and ordered by its next eligible attempt time; failed rows no longer consume a fixed retry page on every poll.
- 2026-07-12 04:42:50 PKT — Moved the sync readiness and release migration contract to `20260712180000`, so releases and readiness reject databases that lack durable lifecycle retry scheduling.
- 2026-07-12 04:42:50 PKT — Added integration coverage for a full poison page with no fresh work. The durable queue exposes no eligible intent until the capped retry deadline, avoiding repeated full-page transactions at the polling cadence.
- 2026-07-12 04:42:50 PKT — Regenerated SQLC after adding the durable retry deadline column so API model and query surfaces match the migration ledger.
- 2026-07-12 04:50 PKT — Verified migration `20260712180000` is applied to the isolated PostgreSQL 18.3 database and confirmed the `next_attempt_at` column plus due-work partial index in the live catalog.
- 2026-07-12 04:50 PKT — Ran the focused lifecycle, Postgres lifecycle, readiness, and retention suites against the migrated database: 16 tests passed. Ran the affected API lifecycle, Postgres adapter, and HTTP packages against the same database: all three packages passed.
- 2026-07-12 04:49:15 PKT — Applied, rolled back, and reapplied `20260712180000` on isolated Postgres at `127.0.0.1:56432`; Goose finished at version `20260712180000` and the due-work index was present.
- 2026-07-12 04:49:31 PKT — Focused real-Postgres lifecycle consumer and readiness probe tests passed: 7 tests, 0 failures. The expected poison-intent error logs exercised durable error recording and retry deferral.
