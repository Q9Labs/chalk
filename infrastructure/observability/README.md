# Local observability

The local Chalk observability stack uses the official
`grafana/otel-lgtm:0.28.0` development image. It runs Grafana, Tempo, Loki,
Prometheus, Pyroscope, and an OpenTelemetry Collector on localhost through
OrbStack's Docker-compatible CLI.

## Run

```bash
pnpm run observability:start
pnpm run observability:smoke
pnpm run observability:e2e
```

Open the provisioned Chalk dashboard at:

```text
http://127.0.0.1:3000/d/chalk-observability-v1/chalk-observability
```

The local Grafana administrator credentials are `admin` / `admin`. Anonymous
local access is viewer-only.

OTLP exporters use these endpoints:

```text
http://127.0.0.1:4318   OTLP over HTTP
http://127.0.0.1:4317   OTLP over gRPC
```

`pnpm run observability:smoke` sends one trace, metric, and correlated log, then
proves that Grafana provisioned the dashboard and that Tempo, Prometheus, and
Loki can query their respective signal. It also verifies the webhook panels,
the shared Journey ID filter, and every provisioned webhook alert rule.

The stack also emits this independent pipeline canary every minute. Separate
critical rules verify the canary metric in Prometheus, trace in Tempo, and log
in Loki, so a single healthy signal cannot hide another broken pipeline.

`pnpm run observability:e2e` recreates the stack-owned database and runs uniquely
named API and sync builds on ephemeral localhost ports. Its telemetry proof
drives a real WebSocket command and API intake, proves duplicate replay, queries
the durable ledger, and verifies the linked Tempo, Prometheus, Loki, and Grafana
surfaces.

The same command starts a raw-body Node receiver backed by the built
`@q9labsai/chalk-client/webhooks` processor and a durable test inbox under a
unique `.private/observability-e2e-*` directory. A temporary Cloudflare quick
tunnel is the only public listener; the receiver, API, sync process, database,
and observability stack remain on `127.0.0.1`. The proof creates its Tenant and
Endpoint through the generated public management client, forces one 503,
restarts the dispatcher while the Delivery is durably waiting, verifies the
signed retry and its Attempt trace, then manually redelivers the Event and
proves the receiver still records one side effect. The trap stops every API,
sync, receiver, tunnel, and proof child while retaining private evidence for
inspection. This command requires outbound network access for the quick tunnel.

The same dashboard shows webhook queue age, first-Attempt p99, active Delivery
states, terminal outcomes, per-Event throughput, cleanup age, and unterminated
journey branches. Its webhook rules cover a five-minute eligible backlog,
first-Attempt SLO breach, Delivery exhaustion, lease churn, missing terminal
branches after the 72-hour window, cleanup outside the daily bound, and absence
of a fresh configured signed canary. These sit beside the critical rules for
collector refusals, journey-ledger write
failures, and stale independent telemetry signals. Managed deployments must
route them through an independently tested human notification path.

The durable journey skeleton remains in the API's Postgres
`observability_journey_events` table. Grafana's provisioned `Chalk Journey
Ledger` data source displays it beside operational telemetry. Entering a
Journey ID in the dashboard filters both this ledger and correlated logs. The
local data source owns an isolated `chalk_observability` database on localhost
port `55432`, so existing development migration history cannot break the
dashboard.

## Recurring signed canary

`pnpm run observability:webhook-canary` is a foreground recurring probe for a
pre-provisioned Endpoint whose receiver verifies Chalk signatures and persists
idempotency state. It is disabled by missing configuration rather than silently
pretending to run. Supply these values through the deployment secret and
scheduler mechanism:

```text
CHALK_WEBHOOK_CANARY_API_URL
CHALK_WEBHOOK_CANARY_TOKEN
CHALK_WEBHOOK_CANARY_TENANT_ID
CHALK_WEBHOOK_CANARY_ENDPOINT_ID
CHALK_WEBHOOK_CANARY_OTLP_ENDPOINT
CHALK_WEBHOOK_CANARY_INTERVAL_SECONDS
```

Each successful `endpoint.test` emits
`chalk_webhook_canary_last_success_unixtime`. The
`chalk-webhook-canary-missing` rule alerts when that proof is older than 15
minutes and deliberately treats no data as alerting, so merely provisioning the
rule cannot be mistaken for operating the canary. Use `node
infrastructure/observability/scripts/webhook-canary.mjs --once` for a scheduler
that supplies its own recurrence.

## Lifecycle

```bash
pnpm run observability:status
pnpm run observability:logs
pnpm run observability:stop
pnpm run observability:reset
```

`stop` preserves the named observability volume. `reset` removes it. This stack
is for local development, automated proof, and demos. Managed deployment
configuration must use external credentials and production-grade backends.
