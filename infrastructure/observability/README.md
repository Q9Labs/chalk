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
Loki can query their respective signal.

The stack also emits this independent pipeline canary every minute. Separate
critical rules verify the canary metric in Prometheus, trace in Tempo, and log
in Loki, so a single healthy signal cannot hide another broken pipeline.

`pnpm run observability:e2e` recreates the stack-owned database, runs uniquely
named API and sync builds on ephemeral localhost ports, drives the public client
telemetry API through a real WebSocket command and API intake, proves duplicate
replay, queries the durable ledger, and verifies that Tempo holds one trace with
both services while Loki holds its correlated API log. It stops the temporary
API and sync processes while retaining the journey for the dashboard. The proof
also shortens the standard OpenTelemetry metric interval for that temporary API
process and queries the accepted and duplicate counters in Prometheus.

Grafana also provisions critical rules for collector refusals, journey-ledger
write failures, and stale independent canary signals. These rules make
monitoring blindness visible inside the same operational surface. Managed
deployments must route them through an independently tested human notification
path.

The durable journey skeleton remains in the API's Postgres
`observability_journey_events` table. Grafana's provisioned `Chalk Journey
Ledger` data source displays it beside operational telemetry. The local data
source owns an isolated `chalk_observability` database on localhost port
`55432`, so existing development migration history cannot break the dashboard.

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
