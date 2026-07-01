# Chalk API Local Performance Report

Generated: 2026-06-30T14:57:51Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 664ms |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 9ms |

## Load Phase

- Duration: 15.003s
- Concurrency: 32
- Requests: 179737
- Errors: 0
- Throughput: 11979.9 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 38.5 MiB |
| RSS mean | 36.3 MiB |
| CPU max | 201.0% |
| CPU mean | 182.0% |
| File descriptors max | 77 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 25142 | 0 | 200:25142 | 0.362ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 0.301ms | 0.027ms | 0.006ms | 0.000ms | 1ms | 3ms | 19ms |
| `GET /readyz` | 31160 | 0 | 200:31160 | 2ms | 0.000ms | 0.001ms | 0.000ms | 0.027ms | 1ms | 0.053ms | 1ms | 0.000ms | 3ms | 5ms | 149ms |
| `GET /v1/regions` | 29808 | 0 | 200:29808 | 0.341ms | 0.000ms | 0.000ms | 0.000ms | 0.028ms | 0.285ms | 0.026ms | 0.010ms | 0.000ms | 1ms | 2ms | 19ms |
| `GET /v1/tenants` | 35556 | 0 | 200:35556 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.029ms | 3ms | 0.062ms | 2ms | 2ms | 6ms | 8ms | 234ms |
| `GET /v1/tenants/{id}` | 31616 | 0 | 200:31616 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.030ms | 2ms | 0.055ms | 1ms | 1ms | 4ms | 6ms | 175ms |
| `PATCH /v1/tenants/{id}` | 13803 | 0 | 200:13803 | 10ms | 0.000ms | 0.000ms | 0.000ms | 0.042ms | 10ms | 0.085ms | 9ms | 9ms | 16ms | 22ms | 216ms |
| `POST /v1/tenants` | 12652 | 0 | 201:12652 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.041ms | 9ms | 0.091ms | 9ms | 9ms | 16ms | 20ms | 215ms |

## Stress Phase

- Duration: 15.013s
- Concurrency: 90
- Requests: 191726
- Errors: 0
- Throughput: 12770.9 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 43.4 MiB |
| RSS mean | 43.0 MiB |
| CPU max | 215.7% |
| CPU mean | 204.9% |
| File descriptors max | 162 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 25985 | 0 | 200:25985 | 0.334ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 0.296ms | 0.015ms | 0.006ms | 0.000ms | 1ms | 3ms | 16ms |
| `GET /readyz` | 33368 | 0 | 200:33368 | 7ms | 0.000ms | 0.000ms | 0.000ms | 0.019ms | 7ms | 0.038ms | 7ms | 0.000ms | 10ms | 13ms | 27ms |
| `GET /v1/regions` | 32482 | 0 | 200:32482 | 0.306ms | 0.000ms | 0.000ms | 0.000ms | 0.020ms | 0.270ms | 0.014ms | 0.010ms | 0.000ms | 0.971ms | 2ms | 17ms |
| `GET /v1/tenants` | 38337 | 0 | 200:38337 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.019ms | 9ms | 0.039ms | 9ms | 8ms | 13ms | 16ms | 36ms |
| `GET /v1/tenants/{id}` | 33946 | 0 | 200:33946 | 8ms | 0.000ms | 0.000ms | 0.000ms | 0.020ms | 8ms | 0.037ms | 7ms | 7ms | 11ms | 14ms | 35ms |
| `PATCH /v1/tenants/{id}` | 14333 | 0 | 200:14333 | 17ms | 0.000ms | 0.000ms | 0.000ms | 0.029ms | 17ms | 0.048ms | 17ms | 17ms | 26ms | 32ms | 73ms |
| `POST /v1/tenants` | 13275 | 0 | 201:13275 | 17ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 17ms | 0.048ms | 16ms | 16ms | 24ms | 31ms | 69ms |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
