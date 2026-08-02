# Chalk API Local Performance Report

Generated: 2026-06-30T15:04:10Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 653ms |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 8ms |

## Load Phase

- Duration: 15.003s
- Concurrency: 32
- Requests: 189630
- Errors: 0
- Throughput: 12639.1 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 35.6 MiB |
| RSS mean | 34.1 MiB |
| CPU max | 207.0% |
| CPU mean | 189.1% |
| File descriptors max | 69 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 26745 | 0 | 200:26745 | 0.363ms | 0.000ms | 0.000ms | 0.000ms | 0.033ms | 0.295ms | 0.033ms | 0.006ms | 0.000ms | 1ms | 2ms | 8ms |
| `GET /readyz` | 32439 | 0 | 200:32439 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.030ms | 2ms | 0.069ms | 1ms | 0.000ms | 3ms | 5ms | 89ms |
| `GET /v1/regions` | 31940 | 0 | 200:31940 | 0.342ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 0.279ms | 0.030ms | 0.010ms | 0.000ms | 1ms | 2ms | 10ms |
| `GET /v1/tenants` | 36690 | 0 | 200:36690 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 3ms | 0.071ms | 2ms | 2ms | 5ms | 7ms | 183ms |
| `GET /v1/tenants/{id}` | 33484 | 0 | 200:33484 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.033ms | 2ms | 0.068ms | 2ms | 2ms | 4ms | 5ms | 136ms |
| `PATCH /v1/tenants/{id}` | 14683 | 0 | 200:14683 | 8ms | 0.000ms | 0.000ms | 0.000ms | 0.046ms | 8ms | 0.098ms | 8ms | 8ms | 13ms | 16ms | 162ms |
| `POST /v1/tenants` | 13649 | 0 | 201:13649 | 8ms | 0.000ms | 0.001ms | 0.000ms | 0.045ms | 8ms | 0.092ms | 8ms | 7ms | 12ms | 15ms | 112ms |

## Stress Phase

- Duration: 15.01s
- Concurrency: 90
- Requests: 187330
- Errors: 0
- Throughput: 12480.7 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 39.8 MiB |
| RSS mean | 39.4 MiB |
| CPU max | 214.2% |
| CPU mean | 199.3% |
| File descriptors max | 135 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 25771 | 0 | 200:25771 | 0.345ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 0.305ms | 0.016ms | 0.006ms | 0.000ms | 1ms | 2ms | 23ms |
| `GET /readyz` | 32815 | 0 | 200:32815 | 8ms | 0.000ms | 0.000ms | 0.000ms | 0.020ms | 8ms | 0.040ms | 8ms | 0.000ms | 11ms | 14ms | 54ms |
| `GET /v1/regions` | 31508 | 0 | 200:31508 | 0.320ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 0.285ms | 0.013ms | 0.010ms | 0.000ms | 1ms | 2ms | 18ms |
| `GET /v1/tenants` | 37007 | 0 | 200:37007 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.021ms | 9ms | 0.040ms | 9ms | 9ms | 13ms | 16ms | 39ms |
| `GET /v1/tenants/{id}` | 33098 | 0 | 200:33098 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 9ms | 0.038ms | 8ms | 8ms | 11ms | 14ms | 38ms |
| `PATCH /v1/tenants/{id}` | 14192 | 0 | 200:14192 | 15ms | 0.000ms | 0.001ms | 0.000ms | 0.028ms | 15ms | 0.044ms | 15ms | 15ms | 21ms | 26ms | 56ms |
| `POST /v1/tenants` | 12939 | 0 | 201:12939 | 15ms | 0.000ms | 0.001ms | 0.000ms | 0.026ms | 15ms | 0.048ms | 15ms | 14ms | 20ms | 24ms | 50ms |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
