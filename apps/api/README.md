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

For the endpoint design and implementation loop, see
[`docs/route-workflow.md`](docs/route-workflow.md).

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

## Local Observability And Performance

Logging is vendor-neutral and writes structured logs to stdout by default. The
logger attaches stable common fields (`service`, `env`, and `version`) to each
record so deployment infrastructure can ship the same output to CloudWatch,
Loki, Datadog, Better Stack, or another backend later.

Useful production-safe defaults:

```bash
CHALK_API_LOG_FORMAT=json
CHALK_API_LOG_LEVEL=info
CHALK_API_REQUEST_LOGS=errors
CHALK_API_SLOW_REQUEST_MS=250
```

`CHALK_API_REQUEST_LOGS` accepts `off`, `errors`, `slow`, `sampled`, or `all`.
Successful request logs are off by default; startup, shutdown, and error logs
still use the shared logger. `sampled` uses `CHALK_API_REQUEST_SAMPLE_RATE`
between `0` and `1`.

Local profiling hooks remain opt-in and are intended for short diagnostic runs:

```bash
CHALK_API_OPERATION_LOGS=1 CHALK_API_PROFILER=1 CHALK_API_REQUEST_LOGS=all go run ./cmd
```

`CHALK_API_OPERATION_LOGS=1` emits Postgres query timing events to stdout. For
local profiling, it also defaults request logs to `all` unless
`CHALK_API_REQUEST_LOGS` is explicitly set. `CHALK_API_PROFILER=1` mounts Go
profiling handlers under `/debug/pprof`; do not expose it publicly.

For an end-to-end local performance pass:

```bash
apps/api/scripts/perf-local.sh
```

The script verifies local Postgres, applies migrations, builds the API and perf
runner, measures startup/shutdown, samples process footprint, and runs weighted
load against the implemented endpoints. Raw logs stay under `.private/`; the
sanitized Markdown and HTML summaries are written to `scratchpad/`.

## gopls MCP

`gopls MCP` is semantic assistance for Codex sessions. It is useful for
workspace shape, symbol search, references, package API summaries, and fast
diagnostics. The shell gate remains the source of truth.

```bash
codex mcp get gopls_chalk_api
```
