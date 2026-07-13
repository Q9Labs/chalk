# Sync v3 migration verification — 2026-07-13

## 2026-07-13 start

Verifying the untracked `apps/api/db/migrations/20260712233000_add_declarative_sync_v3.sql` unchanged on a uniquely named local PostgreSQL database. The verification will run Goose validation, a fresh full migration, required-schema assertions, a down-to `20260712223000` / up loop crossing the v3 migration, then focused API and Sync PostgreSQL tests where the shared tree permits.

## Verification results

- Local PostgreSQL 18.3 was already running in `chalk-postgres` on `127.0.0.1:5432`; created the isolated database `chalk_sync_v3_verify_20260713_1520` and used `postgres://postgres:postgres@127.0.0.1:5432/chalk_sync_v3_verify_20260713_1520?sslmode=disable` for every verification/test command. No staging, production, or provider database was touched.
- Migration file hash before and after verification: `sha256 052201fe5114c075c1e0c9cfe46b42f47adcfffa40a37295dc9e09f3acbde57f` (`44253` bytes). The file remained unchanged and untracked.
- Goose file validation passed with `cd apps/api && go tool goose -dir db/migrations validate`; Goose v3.27.1 exposes `validate` as a filesystem-only command, so the database URL is intentionally omitted.
- Fresh migration command (no `-allow-missing`) was `cd apps/api && go tool goose -dir db/migrations postgres "$DB" up`. All migrations applied successfully through `20260713120000`, including `20260712233000_add_declarative_sync_v3.sql`.
- Fresh schema assertions passed: `room_sessions.host_exit_policy` exists as `text NOT NULL DEFAULT 'require_transfer'::text`; all six required tables exist: `sync_external_operations`, `sync_admission_requests`, `sync_recordings`, `sync_publication_fences`, `sync_publication_grant_reservations`, and `sync_screen_share_leases`.
- Empty rollback/reapply loop passed. `goose down-to 20260712223000` rolled back `20260713120000`, `20260713100000`, `20260713090000`, `20260713010000`, and `20260712233000`, then reported current version `20260712223000`; `goose up` reapplied v3 and all later migrations to `20260713120000`. Repeated host-policy and six-table assertions passed afterward on PostgreSQL 18.3.
- Focused Go integration tests passed with `CHALK_DATABASE_URL="$DB" CHALK_SYNC_OVERHAUL_TEST_DATABASE_URL="$DB" go test ./internal/adapters/postgres ./internal/httpapi -run 'TestSessionLifecycleRepositoryCreatesSessionIdempotently|TestSessionLifecycleRepositoryProducesTenantControlAndMaximumDurationOperations|TestProviderOperationRepositoryPersistsReceiptsAndMonotonicObservations|TestSessionLifecycleHTTPFlowCommitsProductRowsAndIntents' -count=1 -v`: 3 adapter tests and 1 HTTP test passed.
- Relevant Sync PostgreSQL tests passed with `MIX_ENV=test CHALK_SYNC_TEST_DATABASE_URL="$DB" mix test test/chalk_sync/live/screen_share_lease_postgres_test.exs test/chalk_sync/live/session_postgres_test.exs test/chalk_sync/stateholder/postgres_external_operation_test.exs test/chalk_sync/stateholder/postgres_role_transition_test.exs --seed 0`: 42 tests, 0 failures.

Parent verification repeated the migration hash and live schema assertions. The
Go API gate passed after the provider-bridge test's two static-analysis defects
were fixed by its owning lane. The repository gate then passed security,
contracts, test presence, and the API gate before stopping at ten unrelated
pre-existing formatting failures; none of those files were changed for this
migration repair.

The stale local `chalk` database was backed up inside `chalk-postgres` before
Goose's `-allow-missing` path applied this v3 migration successfully. Goose then
stopped at a separate missing transcription migration because its intentional
legacy-text guard fired. The v3 version, column, and tables remain applied; no
staging, production, or provider database was touched.

Status: done. No migration defect was observed, so the canonical DDL was not
edited. The migration and this evidence are integrated as one isolated change.
