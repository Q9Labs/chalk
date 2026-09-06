# API database work

The API uses pgx, sqlc, and goose. It opens a pool at startup but does not run migrations. Commands below run from the repo root.

## Local services

```sh
apps/api/scripts/dev-services.sh start
apps/api/scripts/dev-services.sh describe
```

These manage Postgres and Redis through OrbStack-compatible container commands and print local connection URLs. For one service, use `dev-postgres.sh` or `dev-redis.sh` in the same directory. The scripts define image versions.

## Schema changes

`apps/api/db/migrations/*.sql` is the migration source used by goose and sqlc. Keep `db/schema.sql`, the human-readable snapshot, in sync; editing it alone doesn't change a database.

Add `YYYYMMDDHHMMSS_description.sql` with goose `Up` and `Down` sections. Use a safe rollback, or make `Down` fail explicitly for an irreversible migration. Test reversible changes locally:

```sh
apps/api/scripts/db-migrate.sh up
apps/api/scripts/db-migrate.sh down
apps/api/scripts/db-migrate.sh up
```

`db-migrate.sh` defaults to the local database. For managed databases, set `CHALK_DATABASE_URL` to the direct owner connection, not the runtime/PgBouncer URL.

Production images contain `chalk-migrate` and the checked-in migrations. Before API/Sync activation, the controller runs a one-shot migration to the release manifest's `minimum_migration`. Owner credentials stay out of runtime services. Only an explicitly named checked-in repair may fill an out-of-order gap; other gaps fail. API readiness rejects an older schema. Runtime rollback does not undo migrations.

## Queries

Write named sqlc queries in `apps/api/db/queries`, then generate and verify:

```sh
apps/api/scripts/db-generate.sh run
apps/api/scripts/gate.sh
```

Generated Go lives in `apps/api/internal/adapters/postgres/sqlc`; don't edit it. Use `queries.WithTx(tx)` for transaction-scoped queries. The gate needs reachable Postgres; migration up/down checks are separate.
