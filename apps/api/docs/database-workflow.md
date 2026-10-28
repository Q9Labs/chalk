# API database work

The API uses pgx, sqlc, and goose. `apps/api/scripts/dev-services.sh` manages local Postgres and Redis. The API opens a pool at startup but does not run migrations.

## Schema changes

`apps/api/db/migrations/*.sql` is the source used by goose and sqlc. Keep `db/schema.sql`, the human-readable snapshot, in sync; editing it alone doesn't change a database. Add a timestamped migration with goose `Up` and `Down` sections. Use a safe rollback, or make `Down` fail explicitly if the migration is irreversible. Test reversible changes with up, down, and up using `apps/api/scripts/db-migrate.sh`.

For managed databases, use the direct owner connection in `CHALK_DATABASE_URL`, not the runtime/PgBouncer URL. The controller runs checked-in migrations to the release manifest's `minimum_migration` before API/Sync activation. Owner credentials stay out of runtime services. Only an explicitly named checked-in repair may fill an out-of-order gap; other gaps fail. API readiness rejects an older schema. Runtime rollback does not undo migrations.

## Keep the previous release runnable

An `Up` migration must not remove or rename a table, column, type, or constraint that the previous release still uses. Use two releases: first stop using the object, then drop it only after that release is in production. The previous image must work without undoing migrations.

The API gate checks new migrations for destructive changes. A deliberate second-release removal needs a standalone `-- chalk:removed-in #<PR>` comment in `Up` naming the merged PR that stopped using the object. This marker is an assertion, not proof: verify that the PR removed every use and is already in production. The check does not prove dynamic SQL or data changes safe. For its narrow concurrent-index retry exception, see `apps/api/scripts/check-additive-migrations.mjs`.

## Queries and verification

Write named sqlc queries in `apps/api/db/queries`, then run `apps/api/scripts/db-generate.sh run`; do not edit generated Go under `apps/api/internal/adapters/postgres/sqlc`. Use `queries.WithTx(tx)` for transaction-scoped queries. Run `apps/api/scripts/gate.sh` with Postgres available; migration up/down checks are separate.
