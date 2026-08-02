# Chalk API Local Performance Report

Generated: 2026-06-30T14:56:55Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`
- Server trace log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 768ms |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 8ms |

## Load Phase

- Duration: 15.005s
- Concurrency: 32
- Requests: 172638
- Errors: 0
- Throughput: 11505.5 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 31.4 MiB |
| RSS mean | 30.2 MiB |
| CPU max | 227.4% |
| CPU mean | 206.5% |
| File descriptors max | 55 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 24209 | 0 | 200:24209 | 0.431ms | 0.000ms | 0.000ms | 0.000ms | 0.033ms | 0.365ms | 0.031ms | 0.008ms | 0.000ms | 1ms | 2ms | 9ms |
| `GET /readyz` | 28081 | 0 | 200:28081 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 3ms | 0.061ms | 3ms | 0.000ms | 5ms | 6ms | 48ms |
| `GET /v1/regions` | 29376 | 0 | 200:29376 | 0.403ms | 0.000ms | 0.000ms | 0.000ms | 0.031ms | 0.343ms | 0.028ms | 0.013ms | 0.000ms | 1ms | 2ms | 10ms |
| `GET /v1/tenants` | 32614 | 0 | 200:32614 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 3ms | 0.058ms | 3ms | 3ms | 5ms | 7ms | 50ms |
| `GET /v1/tenants/{id}` | 31653 | 0 | 200:31653 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 3ms | 0.061ms | 3ms | 3ms | 5ms | 7ms | 49ms |
| `PATCH /v1/tenants/{id}` | 13845 | 0 | 200:13845 | 6ms | 0.000ms | 0.000ms | 0.000ms | 0.044ms | 6ms | 0.055ms | 5ms | 5ms | 8ms | 10ms | 54ms |
| `POST /v1/tenants` | 12860 | 0 | 201:12860 | 6ms | 0.000ms | 0.000ms | 0.000ms | 0.046ms | 6ms | 0.059ms | 5ms | 5ms | 8ms | 10ms | 52ms |

## Stress Phase

- Duration: 15.013s
- Concurrency: 90
- Requests: 172076
- Errors: 0
- Throughput: 11461.6 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 35.6 MiB |
| RSS mean | 35.2 MiB |
| CPU max | 214.5% |
| CPU mean | 203.9% |
| File descriptors max | 137 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 23973 | 0 | 200:23973 | 0.407ms | 0.000ms | 0.003ms | 0.000ms | 0.024ms | 0.362ms | 0.017ms | 0.007ms | 0.000ms | 1ms | 3ms | 18ms |
| `GET /readyz` | 28261 | 0 | 200:28261 | 10ms | 0.000ms | 0.002ms | 0.000ms | 0.022ms | 10ms | 0.035ms | 10ms | 0.000ms | 14ms | 16ms | 39ms |
| `GET /v1/regions` | 29169 | 0 | 200:29169 | 0.384ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 0.344ms | 0.015ms | 0.011ms | 0.000ms | 1ms | 2ms | 27ms |
| `GET /v1/tenants` | 32768 | 0 | 200:32768 | 11ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 11ms | 0.034ms | 10ms | 10ms | 14ms | 17ms | 39ms |
| `GET /v1/tenants/{id}` | 31848 | 0 | 200:31848 | 10ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 10ms | 0.034ms | 10ms | 10ms | 14ms | 17ms | 41ms |
| `PATCH /v1/tenants/{id}` | 13604 | 0 | 200:13604 | 13ms | 0.000ms | 0.003ms | 0.000ms | 0.029ms | 13ms | 0.038ms | 13ms | 13ms | 17ms | 21ms | 41ms |
| `POST /v1/tenants` | 12453 | 0 | 201:12453 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.030ms | 13ms | 0.037ms | 13ms | 13ms | 17ms | 20ms | 41ms |

## Trace Shape

With `CHALK_API_TRACE_LOGS=1`, each request gets `X-Request-Id` and `X-Trace-Id` response headers. Server logs contain `http.request` events and Postgres adapter logs contain `db.query` events using the same IDs. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_TRACE_LOGS` and `CHALK_API_PPROF` unset. To strip it from the codebase later, remove `internal/observability`, `internal/postgres/tracing.go`, the observability fields in config, the router middleware/debug options, and `cmd/perf` plus `scripts/perf-local.sh`.
