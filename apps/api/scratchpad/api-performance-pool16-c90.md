# Chalk API Local Performance Report

Generated: 2026-06-30T15:03:30Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 781ms |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 9ms |

## Load Phase

- Duration: 15.005s
- Concurrency: 32
- Requests: 186677
- Errors: 0
- Throughput: 12441.2 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 32.7 MiB |
| RSS mean | 31.5 MiB |
| CPU max | 212.7% |
| CPU mean | 194.4% |
| File descriptors max | 65 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 26442 | 0 | 200:26442 | 0.383ms | 0.000ms | 0.000ms | 0.000ms | 0.036ms | 0.311ms | 0.033ms | 0.007ms | 0.000ms | 1ms | 2ms | 11ms |
| `GET /readyz` | 31001 | 0 | 200:31001 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.031ms | 2ms | 0.074ms | 2ms | 0.000ms | 4ms | 5ms | 61ms |
| `GET /v1/regions` | 31231 | 0 | 200:31231 | 0.367ms | 0.000ms | 0.000ms | 0.000ms | 0.033ms | 0.300ms | 0.032ms | 0.011ms | 0.000ms | 1ms | 2ms | 12ms |
| `GET /v1/tenants` | 35770 | 0 | 200:35770 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 3ms | 0.072ms | 3ms | 2ms | 5ms | 6ms | 90ms |
| `GET /v1/tenants/{id}` | 33773 | 0 | 200:33773 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.035ms | 2ms | 0.075ms | 2ms | 2ms | 4ms | 6ms | 77ms |
| `PATCH /v1/tenants/{id}` | 14554 | 0 | 200:14554 | 7ms | 0.000ms | 0.000ms | 0.000ms | 0.046ms | 7ms | 0.085ms | 6ms | 6ms | 10ms | 12ms | 75ms |
| `POST /v1/tenants` | 13906 | 0 | 201:13906 | 7ms | 0.000ms | 0.000ms | 0.000ms | 0.044ms | 6ms | 0.086ms | 6ms | 6ms | 10ms | 12ms | 77ms |

## Stress Phase

- Duration: 15.014s
- Concurrency: 90
- Requests: 187250
- Errors: 0
- Throughput: 12472.1 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 38.2 MiB |
| RSS mean | 37.5 MiB |
| CPU max | 211.1% |
| CPU mean | 203.0% |
| File descriptors max | 128 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 25898 | 0 | 200:25898 | 0.400ms | 0.000ms | 0.000ms | 0.000ms | 0.023ms | 0.360ms | 0.016ms | 0.008ms | 0.000ms | 1ms | 3ms | 25ms |
| `GET /readyz` | 31511 | 0 | 200:31511 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 9ms | 0.052ms | 9ms | 0.000ms | 12ms | 15ms | 37ms |
| `GET /v1/regions` | 31946 | 0 | 200:31946 | 0.370ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 0.330ms | 0.017ms | 0.011ms | 0.000ms | 1ms | 3ms | 20ms |
| `GET /v1/tenants` | 36331 | 0 | 200:36331 | 10ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 10ms | 0.049ms | 9ms | 9ms | 13ms | 16ms | 49ms |
| `GET /v1/tenants/{id}` | 33683 | 0 | 200:33683 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 9ms | 0.049ms | 9ms | 9ms | 12ms | 16ms | 44ms |
| `PATCH /v1/tenants/{id}` | 14578 | 0 | 200:14578 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.028ms | 13ms | 0.053ms | 13ms | 13ms | 17ms | 21ms | 46ms |
| `POST /v1/tenants` | 13303 | 0 | 201:13303 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.028ms | 13ms | 0.055ms | 13ms | 13ms | 17ms | 21ms | 44ms |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
