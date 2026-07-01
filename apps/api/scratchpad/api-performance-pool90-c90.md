# Chalk API Local Performance Report

Generated: 2026-06-30T14:58:40Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 717ms |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 8ms |

## Load Phase

- Duration: 15.004s
- Concurrency: 32
- Requests: 185090
- Errors: 0
- Throughput: 12336.0 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 38.4 MiB |
| RSS mean | 36.7 MiB |
| CPU max | 206.8% |
| CPU mean | 186.5% |
| File descriptors max | 83 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 25613 | 0 | 200:25613 | 0.328ms | 0.000ms | 0.000ms | 0.000ms | 0.029ms | 0.273ms | 0.025ms | 0.006ms | 0.000ms | 1ms | 2ms | 12ms |
| `GET /readyz` | 32097 | 0 | 200:32097 | 1ms | 0.000ms | 0.000ms | 0.000ms | 0.026ms | 1ms | 0.044ms | 1ms | 0.000ms | 3ms | 4ms | 181ms |
| `GET /v1/regions` | 30758 | 0 | 200:30758 | 0.314ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 0.262ms | 0.024ms | 0.010ms | 0.000ms | 0.995ms | 2ms | 15ms |
| `GET /v1/tenants` | 36662 | 0 | 200:36662 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 3ms | 0.054ms | 2ms | 2ms | 6ms | 8ms | 186ms |
| `GET /v1/tenants/{id}` | 32942 | 0 | 200:32942 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.029ms | 2ms | 0.049ms | 1ms | 1ms | 4ms | 6ms | 203ms |
| `PATCH /v1/tenants/{id}` | 13802 | 0 | 200:13802 | 10ms | 0.000ms | 0.000ms | 0.000ms | 0.041ms | 9ms | 0.076ms | 9ms | 9ms | 16ms | 20ms | 165ms |
| `POST /v1/tenants` | 13216 | 0 | 201:13216 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.040ms | 9ms | 0.082ms | 9ms | 9ms | 15ms | 19ms | 195ms |

## Stress Phase

- Duration: 15.012s
- Concurrency: 90
- Requests: 160470
- Errors: 0
- Throughput: 10689.1 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 59.6 MiB |
| RSS mean | 56.3 MiB |
| CPU max | 174.6% |
| CPU mean | 164.3% |
| File descriptors max | 214 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 21600 | 0 | 200:21600 | 0.246ms | 0.000ms | 0.001ms | 0.000ms | 0.020ms | 0.210ms | 0.014ms | 0.005ms | 0.000ms | 0.783ms | 2ms | 15ms |
| `GET /readyz` | 30367 | 0 | 200:30367 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 3ms | 0.022ms | 3ms | 0.000ms | 7ms | 10ms | 1.001s |
| `GET /v1/regions` | 26348 | 0 | 200:26348 | 0.241ms | 0.000ms | 0.000ms | 0.000ms | 0.019ms | 0.209ms | 0.012ms | 0.008ms | 0.000ms | 0.733ms | 2ms | 29ms |
| `GET /v1/tenants` | 34123 | 0 | 200:34123 | 7ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 7ms | 0.034ms | 7ms | 6ms | 16ms | 24ms | 1.357s |
| `GET /v1/tenants/{id}` | 26523 | 0 | 200:26523 | 4ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 4ms | 0.026ms | 3ms | 3ms | 9ms | 14ms | 1.229s |
| `PATCH /v1/tenants/{id}` | 11076 | 0 | 200:11076 | 48ms | 0.000ms | 0.002ms | 0.000ms | 0.022ms | 48ms | 0.048ms | 47ms | 47ms | 96ms | 144ms | 1.254s |
| `POST /v1/tenants` | 10433 | 0 | 201:10433 | 37ms | 0.000ms | 0.001ms | 0.000ms | 0.023ms | 37ms | 0.050ms | 37ms | 37ms | 61ms | 82ms | 1.366s |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
