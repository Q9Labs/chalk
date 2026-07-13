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

Read the code for more details. Starting at `apps/api/internal/config/config.go`.

Set `CHALK_API_TRUSTED_PROXY_CIDRS` to the comma-separated CIDR ranges of the
load balancers or edge proxies allowed to supply `CF-Connecting-IP` or
`X-Forwarded-For` for public-route rate limiting. Non-local environments use
Redis-backed rate limiting through `CHALK_REDIS_URL`.

## Transcription artifacts

Asynchronous transcription is enabled only when the API can mount the complete
worker boundary. Non-local startup requires R2 and Redis plus
`CHALK_TRANSCRIPTION_WORKLOAD_AUTH_SECRET`,
`CHALK_TRANSCRIPTION_CONTROL_AUDIENCE`, and
`CHALK_TRANSCRIPTION_DISPATCHER_FUNCTION_NAME`. The HMAC secret must match the
dispatcher's SSM-managed workload secret; the audience and API release version
are included in every replay-bound signature. The API uses its AWS workload
identity only to enqueue a small asynchronous Lambda wake hint. The minute
dispatcher schedule reconciles lost hints.

Public transcript requests do not accept providers, object keys, queue
priority, retry budgets, or lifecycle state. Recorder-owned committed source
metadata must exist before a request is accepted, and normalized transcript
bytes remain private R2 artifacts exposed through short-lived download URLs.

### Outbound webhook encryption and erasure

Outbound webhook target URLs and replayable one-time responses are encrypted at
rest. Local development may omit webhook encryption configuration and use the
deterministic local-only default. Every non-local environment fails closed
unless it supplies either `CHALK_WEBHOOK_ENCRYPTION_KEY` as one base64-encoded
32-byte key, or a versioned keyring through
`CHALK_WEBHOOK_ENCRYPTION_KEYRING` plus
`CHALK_WEBHOOK_ENCRYPTION_CURRENT_VERSION`. A keyring entry uses
`version:base64-key`; retain the previous version during a rotation overlap so
existing ciphertext remains decryptable, and make the new version current for
all new writes.

The repository currently uses process-injected AES-GCM keys. It has no KMS or
envelope-key provider, so deployment secret injection and key retirement remain
external operational responsibilities.

User deletion must call `WebhookRepository.EraseUserWebhookEvents` before the
user row is deleted. The hook destroys linked event bodies, terminally fences
their Deliveries, closes an in-flight Attempt as `event_erased`, emits a
content-free terminal journey event, and then removes the user link. This live
erasure path is enforced and directly covered by a PostgreSQL integration test.
The repository does not yet contain a deletion orchestrator or an external
tombstone authority that survives database backup restoration. Therefore a
restored backup can revive pre-erasure webhook bodies or encrypted Endpoint
material and must not be declared ready until an external durable tombstone
reconciler has replayed deletions. Backup restore plus tombstone replay is an
explicit production-readiness blocker, not a capability of the current API.

## Database

The API uses Postgres with `pgx`, `sqlc`, and `goose`. For local Postgres,
migrations, query generation, and schema workflow, see
[`docs/database-workflow.md`](docs/database-workflow.md).

For the full local backing-service set, including Redis:

```bash
apps/api/scripts/dev-services.sh start
```

## Sync participant tokens

Participant admission returns a five-minute Ed25519-signed sync JWT. An
authenticated tenant member can refresh it with
`POST /v1/tenants/{tenant_id}/rooms/{room_id}/sessions/{session_id}/participants/{participant_session_id}/sync-token`.
The refresh path reloads the active participant generation, capabilities, and
admission intent from Postgres before signing.

Production requires `CHALK_SYNC_TOKEN_ISSUER`, `CHALK_SYNC_TOKEN_AUDIENCE`,
`CHALK_SYNC_TOKEN_KEY_ID`, and `CHALK_SYNC_TOKEN_PRIVATE_KEY`. The private key is
the unpadded base64url encoding of a 64-byte Ed25519 private key and must be
supplied through the runtime secret boundary.

## Runtime Smoke

```bash
apps/api/scripts/smoke-healthz.sh
apps/api/scripts/smoke-lifecycle.mjs
```

`smoke-healthz.sh` verifies `/healthz`, `/readyz`, 404, and 405 behavior against
a running API. `smoke-lifecycle.mjs` builds the binary, waits for `/healthz`,
sends `SIGTERM`, and verifies the process exits cleanly within configurable
startup/shutdown budgets.

## Execution Trace Harness

The API includes a local Execution Trace Harness for reviewing one full
application flow, or the full scenario catalog, as a readable timeline. It runs
scripted scenarios through the real HTTP router and service layer with traced
local test doubles at external boundaries.

```bash
go run ./cmd/trace
go run ./cmd/trace -scenario all -style tree -color always
go run ./cmd/trace -scenario tenant-create -format json
go run ./cmd/trace -color always
```

By default, `go run ./cmd/trace` runs every registered scenario. The
`tenant-create` scenario shows request entry, authentication,
principal attachment, service input normalization, repository work, simulated
database transaction/query/result mapping, and the final HTTP response. Trace
text output uses color automatically when stdout is a terminal, and accepts
`-color auto`, `-color always`, or `-color never`. Trace output is local
developer tooling; do not commit raw traces that contain customer data,
production identifiers, secrets, or private operational detail.

For agent guidance on adding scenarios after API work, see
[`docs/execution-trace-harness.md`](docs/execution-trace-harness.md).

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

OpenTelemetry traces and metrics export over OTLP/HTTP when an endpoint is
configured. The endpoint is a base URL; the API sends traces to `/v1/traces`
and metrics to `/v1/metrics`.

```bash
CHALK_API_OTLP_ENDPOINT=https://otel.example.com:4318
```

`CHALK_API_OTLP_INSECURE=true` allows an `http://` endpoint only in `local`
environments. The runtime emits Go runtime metrics, HTTP server spans, database
operation spans, Redis rate-limit spans, and Cloudflare media-plane request
spans. It propagates W3C `traceparent` and mirrors or creates the lowercase
`x-chalk-journey-id` response header. Request bodies and operation content are
never included in traces or logs.

Authenticated runtimes can acknowledge at-least-once journey events through
`POST /v1/telemetry/journey-events`. Event identifiers, journey identifiers,
and parent event identifiers are RFC 4122 UUIDs. The local, system-principal
ledger query route is `GET /v1/telemetry/journeys/{journey_id}`; it is not
mounted outside local environments.

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
