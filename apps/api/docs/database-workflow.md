# Database Workflow

Owner/operator notes for Chalk API database work.

## Current Decision

The API uses:

- `pgx` for Postgres connections and pooling.
- `sqlc` for generated Go query code over `pgx/v5`.
- `goose` for versioned SQL migrations.
- local Postgres in an OrbStack/Docker container named `chalk-postgres`.

The API opens a Postgres pool during startup. It does not apply migrations at
startup; migrations are explicit operator/deploy actions.

## `schema.sql` vs Migrations

`db/schema.sql` is the current schema snapshot. The migration files are the
versioned history that gets real databases from an empty state to that snapshot:

| File                  | Purpose                                                                                            | Should You Edit It?                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `db/schema.sql`       | Human-readable snapshot/draft of the full schema. Useful for design review.                        | Not as the operational source of truth. Keep it in sync manually for now, or regenerate it later. |
| `db/migrations/*.sql` | Versioned history of schema changes that can be applied to real databases. Used by goose and sqlc. | Yes. New schema changes should be new migration files.                                            |

The migration file has two goose sections:

```sql
-- +goose Up
-- schema changes to apply

-- +goose Down
-- rollback steps
```

`Up` applies the change. `Down` rolls it back when rollback is safe.

## Local Postgres

Start or verify the local database:

```bash
apps/api/scripts/dev-postgres.sh start
```

This starts `postgres:18.3-alpine` if needed, waits for readiness, verifies the
server version, and prints the local `CHALK_DATABASE_URL`.

```bash
apps/api/scripts/dev-postgres.sh describe
```

## Migrations With Goose

```bash
apps/api/scripts/db-migrate.sh describe
```

The script defaults to the local database URL from `dev-postgres.sh url`.
For PlanetScale, set `CHALK_DATABASE_URL` to the direct Postgres connection URL
before running migrations. Do not use the pooled runtime/PgBouncer URL for
migrations.

## Adding A Migration

Create a new timestamp-style file under `apps/api/db/migrations`:

```text
YYYYMMDDHHMMSS_short_description.sql
```

Example:

```sql
-- +goose Up
alter table rooms
    add column revision bigint not null default 1;

-- +goose Down
alter table rooms
    drop column revision;
```

Local schema verification loop:

```bash
apps/api/scripts/db-migrate.sh up
apps/api/scripts/db-migrate.sh down
apps/api/scripts/db-migrate.sh up
```

For destructive changes, do not write a fake rollback. Design a safe rollback
or make `Down` intentionally fail with a clear comment explaining why the
migration is irreversible.

## Queries With sqlc

Write SQL queries under `apps/api/db/queries`:

Example:

```sql
-- name: GetTenant :one
select id, name
from tenants
where id = $1;
```

Generate Go code:

```bash
apps/api/scripts/db-generate.sh run
apps/api/scripts/db-generate.sh describe
```

Generated code goes to `apps/api/internal/postgres/db`. Do not edit generated
files manually.

`sqlc` reads schema from `db/migrations` and queries from `db/queries`.
The generated package uses `pgx/v5`, including:

- `db.New(pool)` for normal query execution;
- `queries.WithTx(tx)` for transaction-scoped execution;
- generated parameter/result structs;
- a generated `Querier` interface when useful for adapters/tests.

## Quality Gate

```bash
apps/api/scripts/gate.sh describe
apps/api/scripts/gate.sh
```

The gate starts the API binary, so Postgres must be reachable. Migration up/down
execution is checked separately through `db-migrate.sh` when touching schema.

## Mental Model

Use this ordering:

1. Change schema by adding a goose migration.
2. Add or update SQL queries under `db/queries`.
3. Run `apps/api/scripts/db-generate.sh`.
4. Run migration up/down/up locally if schema changed.
5. Run `apps/api/scripts/gate.sh`.

Migrations are the timeline. sqlc is the compiler. pgx is the runtime driver.
