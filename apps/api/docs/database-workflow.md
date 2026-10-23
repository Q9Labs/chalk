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

## Keep the previous release runnable

A migration's `Up` section must not remove or rename a table, column, type, or
constraint that the previous release still uses. Removal takes two releases:
the first stops using the object; the second drops it and names the pull request
that stopped using it. That pull request must already be in production before
the drop ships. Redeploying the previous image must work without undoing migrations.

The API gate checks migrations added since the merge base with `origin/master`
(`GATE_BASE_REF` overrides the base). Existing migrations are exempt. In `Up`,
the check rejects `DROP` (including `ALTER ... DROP`), `RENAME`, and
`ALTER [COLUMN] name TYPE` / `ALTER [COLUMN] name SET DATA TYPE`.
`Down` is exempt. A deliberate second-release removal needs this standalone
comment inside `Up`, with the number of the merged pull request that stopped
using the object:

```sql
-- +goose Up
-- chalk:removed-in #248
ALTER TABLE example DROP COLUMN unused_column;
```

The marker is a review assertion, not proof of compatibility. Reviewers must
verify that the named pull request removed every use of the affected objects and
that production already runs it. The check
ignores SQL comments, quoted identifiers, and ordinary string values; it also
checks dollar-quoted bodies. It does not prove dynamic SQL or data changes safe.

One narrow exception: a `NO TRANSACTION` migration that builds an index
concurrently may drop that same index first, so a run that stopped part-way
starts again from nothing. The marker then names the pull request that adds the
migration, the index must be new in that migration, and the comment above the
drop must say that it removes whatever an earlier run of this migration left
behind, finished or not.

## Queries

Write named sqlc queries in `apps/api/db/queries`, then generate and verify:

```sh
apps/api/scripts/db-generate.sh run
apps/api/scripts/gate.sh
```

Generated Go lives in `apps/api/internal/adapters/postgres/sqlc`; don't edit it. Use `queries.WithTx(tx)` for transaction-scoped queries. The gate needs reachable Postgres; migration up/down checks are separate.
