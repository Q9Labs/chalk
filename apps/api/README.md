# Chalk API

Go control-plane API for Chalk.

The architecture follows
[`../../docs/redesign/north-star.md`](../../docs/redesign/north-star.md):
thin process wiring in `cmd/main.go`, HTTP as an inbound adapter, domain logic
behind composable boundaries, and provider-specific details kept in adapters.

Public REST routes live under one `/v1` boundary. Operational routes stay
unversioned:

- `/healthz`: process liveness.
- `/readyz`: dependency readiness, currently Postgres.

## Gate

Learn about the gate by running:

```bash
apps/api/scripts/gate.sh describe
```

## Runtime Config

Config is env-only. Secret managers or platform-specific config systems should
inject environment variables before the API starts.

The API follows twelve-factor app principles where they help portability:
config in the environment, logs to stdout/stderr, explicit backing services,
disposable processes with graceful shutdown, and no runtime mutation of source
or generated files. The config package is the source of truth for supported
environment variables and defaults.

## Database

The API uses Postgres with `pgx`, `sqlc`, and `goose`. For local Postgres,
migrations, query generation, and schema workflow, see
[`docs/database-workflow.md`](docs/database-workflow.md).

## Runtime Smoke

```bash
apps/api/scripts/smoke-healthz.sh
apps/api/scripts/smoke-lifecycle.mjs
```

`smoke-healthz.sh` verifies `/healthz`, `/readyz`, 404, and 405 behavior against
a running API. `smoke-lifecycle.mjs` builds the binary, waits for `/healthz`,
sends `SIGTERM`, and verifies the process exits cleanly within configurable
startup/shutdown budgets.

## gopls MCP

`gopls MCP` is semantic assistance for Codex sessions. It is useful for
workspace shape, symbol search, references, package API summaries, and fast
diagnostics. The shell gate remains the source of truth.

```bash
codex mcp get gopls_chalk_api
```
