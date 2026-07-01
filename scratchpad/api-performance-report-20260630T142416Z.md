# Chalk API Local Performance Report

Generated: 2026-06-30T14:25:10Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 690ms |
| Startup to /readyz | 2ms |
| Graceful shutdown after SIGTERM | 9ms |

## Load Phase

- Duration: 20.004s
- Concurrency: 32
- Requests: 248571
- Errors: 0
- Throughput: 12426.3 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 31.2 MiB |
| RSS mean | 30.4 MiB |
| CPU max | 240.8% |
| CPU mean | 217.7% |
| File descriptors max | 59 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 36797 | 0 | 200:36797 | 0.558ms | 0.000ms | 0.000ms | 0.000ms | 0.037ms | 0.476ms | 0.043ms | 0.009ms | 0.000ms | 2ms | 3ms | 26ms |
| `GET /readyz` | 39527 | 0 | 200:39527 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.036ms | 3ms | 0.084ms | 2ms | 0.000ms | 4ms | 6ms | 52ms |
| `GET /v1/regions` | 41938 | 0 | 200:41938 | 0.532ms | 0.000ms | 0.000ms | 0.000ms | 0.037ms | 0.452ms | 0.041ms | 0.014ms | 0.000ms | 2ms | 3ms | 27ms |
| `GET /v1/tenants` | 44885 | 0 | 200:44885 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.037ms | 3ms | 0.080ms | 3ms | 2ms | 5ms | 7ms | 67ms |
| `GET /v1/tenants/{id}` | 45311 | 0 | 200:45311 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.038ms | 3ms | 0.079ms | 2ms | 2ms | 5ms | 7ms | 59ms |
| `PATCH /v1/tenants/{id}` | 20671 | 0 | 200:20671 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.050ms | 5ms | 0.075ms | 5ms | 5ms | 8ms | 10ms | 69ms |
| `POST /v1/tenants` | 19442 | 0 | 201:19442 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.051ms | 5ms | 0.078ms | 5ms | 4ms | 8ms | 10ms | 62ms |

## Stress Phase

- Duration: 20.018s
- Concurrency: 128
- Requests: 257339
- Errors: 0
- Throughput: 12855.6 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 39.5 MiB |
| RSS mean | 38.9 MiB |
| CPU max | 235.7% |
| CPU mean | 212.2% |
| File descriptors max | 162 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 36825 | 0 | 200:36825 | 0.509ms | 0.000ms | 0.001ms | 0.000ms | 0.023ms | 0.468ms | 0.016ms | 0.007ms | 0.000ms | 2ms | 3ms | 253ms |
| `GET /readyz` | 41286 | 0 | 200:41286 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 13ms | 0.037ms | 13ms | 0.000ms | 17ms | 22ms | 278ms |
| `GET /v1/regions` | 43890 | 0 | 200:43890 | 0.463ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 0.426ms | 0.014ms | 0.011ms | 0.000ms | 1ms | 3ms | 17ms |
| `GET /v1/tenants` | 47157 | 0 | 200:47157 | 14ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 14ms | 0.037ms | 13ms | 13ms | 17ms | 22ms | 279ms |
| `GET /v1/tenants/{id}` | 47382 | 0 | 200:47382 | 14ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 14ms | 0.035ms | 13ms | 13ms | 17ms | 22ms | 277ms |
| `PATCH /v1/tenants/{id}` | 21344 | 0 | 200:21344 | 16ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 16ms | 0.038ms | 16ms | 15ms | 20ms | 26ms | 286ms |
| `POST /v1/tenants` | 19455 | 0 | 201:19455 | 16ms | 0.000ms | 0.001ms | 0.000ms | 0.026ms | 16ms | 0.039ms | 16ms | 15ms | 20ms | 26ms | 282ms |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
