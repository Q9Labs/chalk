# Chalk API Local Performance Report

Generated: 2026-07-12T17:29:23Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `/v1/me`, tenants, regions, rooms, room sessions, recordings, recording download URL edge, transcripts, and audit logs.
- Protected `/v1` requests use a perf-only bearer session seeded directly into the configured local Postgres database.
- Server log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 54ms |
| Startup to /readyz | 0.702ms |
| Graceful shutdown after SIGTERM | 3ms |

## Load Phase

- Duration: 20.005s
- Concurrency: 32
- Requests: 120103
- Errors: 15
- Throughput: 6003.7 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 43.0 MiB |
| RSS mean | 41.6 MiB |
| CPU max | 209.6% |
| CPU mean | 186.6% |
| File descriptors max | 54 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 8085 | 0 | 200:8085 | 0.188ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 0.156ms | 0.018ms | 0.004ms | 0.000ms | 0.341ms | 0.633ms | 6ms |
| `GET /readyz` | 12385 | 0 | 200:12385 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 3ms | 0.020ms | 3ms | 0.000ms | 4ms | 5ms | 54ms |
| `GET /v1/me` | 4433 | 0 | 200:133 429:4300 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 3ms | 0.022ms | 3ms | 0.000ms | 5ms | 6ms | 51ms |
| `GET /v1/regions` | 7580 | 0 | 200:7580 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 3ms | 0.020ms | 3ms | 0.000ms | 5ms | 6ms | 57ms |
| `GET /v1/tenants/{id}` | 7452 | 0 | 200:7452 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 9ms | 0.021ms | 9ms | 0.000ms | 12ms | 15ms | 91ms |
| `GET /v1/tenants/{id}/audit-logs` | 3450 | 0 | 200:3450 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 9ms | 0.021ms | 9ms | 0.000ms | 12ms | 15ms | 92ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 3415 | 0 | 200:3415 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.016ms | 9ms | 0.020ms | 9ms | 0.000ms | 12ms | 16ms | 86ms |
| `GET /v1/tenants/{id}/recordings` | 4151 | 0 | 200:4151 | 10ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 9ms | 0.021ms | 9ms | 0.000ms | 13ms | 16ms | 86ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 4146 | 0 | 200:4146 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 9ms | 0.021ms | 9ms | 0.000ms | 12ms | 16ms | 74ms |
| `GET /v1/tenants/{id}/rooms` | 3746 | 0 | 200:3746 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 9ms | 0.021ms | 9ms | 0.000ms | 12ms | 15ms | 41ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 3799 | 0 | 200:3799 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 9ms | 0.022ms | 9ms | 0.000ms | 12ms | 15ms | 76ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 3818 | 0 | 200:3818 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.015ms | 9ms | 0.021ms | 9ms | 0.000ms | 13ms | 17ms | 93ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 3767 | 0 | 200:3767 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 9ms | 0.021ms | 9ms | 0.000ms | 12ms | 16ms | 86ms |
| `GET /v1/tenants/{id}/transcripts` | 3847 | 0 | 200:3847 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 9ms | 0.024ms | 9ms | 0.000ms | 13ms | 16ms | 78ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 3790 | 0 | 200:3790 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 9ms | 0.023ms | 9ms | 0.000ms | 13ms | 16ms | 75ms |
| `PATCH /v1/tenants/{id}` | 3723 | 0 | 200:8 429:3715 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 7ms | 61ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 4155 | 0 | 200:7 429:4148 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.017ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 6ms | 116ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 3740 | 0 | 200:12 429:3728 | 3ms | 0.000ms | 0.001ms | 0.000ms | 0.019ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 7ms | 106ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 3910 | 7 | 400:7 429:3903 | 3ms | 0.000ms | 0.001ms | 0.000ms | 0.019ms | 3ms | 0.022ms | 3ms | 0.000ms | 5ms | 6ms | 57ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 3494 | 0 | 200:4 429:3490 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.023ms | 3ms | 0.000ms | 5ms | 6ms | 55ms |
| `POST /v1/tenants` | 3728 | 0 | 201:6 429:3722 | 3ms | 0.000ms | 0.001ms | 0.000ms | 0.018ms | 3ms | 0.022ms | 3ms | 0.000ms | 5ms | 7ms | 68ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 4030 | 0 | 429:4024 503:6 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 6ms | 23ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 3620 | 0 | 201:6 429:3614 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.022ms | 3ms | 0.000ms | 5ms | 7ms | 99ms |
| `POST /v1/tenants/{id}/rooms` | 3751 | 0 | 201:7 429:3744 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 7ms | 42ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 3856 | 8 | 400:8 429:3848 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.022ms | 3ms | 0.000ms | 5ms | 7ms | 53ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 4232 | 0 | 201:8 429:4224 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.019ms | 3ms | 0.021ms | 3ms | 0.000ms | 5ms | 7ms | 47ms |

## Stress Phase

- Duration: 20.02s
- Concurrency: 128
- Requests: 133243
- Errors: 4
- Throughput: 6655.4 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 52.1 MiB |
| RSS mean | 51.5 MiB |
| CPU max | 213.3% |
| CPU mean | 206.6% |
| File descriptors max | 170 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 9579 | 0 | 200:9579 | 0.172ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 0.143ms | 0.016ms | 0.003ms | 0.000ms | 0.260ms | 0.485ms | 7ms |
| `GET /readyz` | 14448 | 0 | 200:14448 | 11ms | 0.000ms | 0.000ms | 0.000ms | 0.011ms | 11ms | 0.019ms | 11ms | 0.000ms | 14ms | 16ms | 23ms |
| `GET /v1/me` | 5246 | 0 | 200:33 429:5213 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 12ms | 0.021ms | 11ms | 0.000ms | 14ms | 16ms | 24ms |
| `GET /v1/regions` | 8341 | 0 | 200:8341 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 12ms | 0.019ms | 11ms | 0.000ms | 14ms | 16ms | 27ms |
| `GET /v1/tenants/{id}` | 8201 | 0 | 200:8201 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.020ms | 34ms | 0.000ms | 41ms | 45ms | 52ms |
| `GET /v1/tenants/{id}/audit-logs` | 4060 | 0 | 200:4060 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 34ms | 0.020ms | 34ms | 0.000ms | 41ms | 44ms | 52ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 3941 | 0 | 200:3941 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.020ms | 34ms | 0.000ms | 40ms | 44ms | 52ms |
| `GET /v1/tenants/{id}/recordings` | 4195 | 0 | 200:4195 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.020ms | 34ms | 0.000ms | 41ms | 45ms | 53ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 4248 | 0 | 200:4248 | 34ms | 0.000ms | 0.001ms | 0.000ms | 0.013ms | 34ms | 0.020ms | 34ms | 0.000ms | 41ms | 44ms | 50ms |
| `GET /v1/tenants/{id}/rooms` | 4065 | 0 | 200:4065 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.020ms | 34ms | 0.000ms | 41ms | 45ms | 51ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 4335 | 0 | 200:4335 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.019ms | 34ms | 0.000ms | 41ms | 44ms | 51ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 4250 | 0 | 200:4250 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 34ms | 0.019ms | 34ms | 0.000ms | 41ms | 44ms | 51ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 4296 | 0 | 200:4296 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.019ms | 34ms | 0.000ms | 41ms | 44ms | 56ms |
| `GET /v1/tenants/{id}/transcripts` | 4153 | 0 | 200:4153 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.021ms | 34ms | 0.000ms | 40ms | 44ms | 51ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 4109 | 0 | 200:4109 | 34ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 34ms | 0.021ms | 34ms | 0.000ms | 41ms | 44ms | 50ms |
| `PATCH /v1/tenants/{id}` | 4056 | 0 | 200:1 429:4055 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.021ms | 11ms | 0.000ms | 14ms | 16ms | 44ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 4152 | 0 | 200:3 429:4149 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.019ms | 11ms | 0.000ms | 14ms | 16ms | 43ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 4163 | 0 | 200:3 429:4160 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 12ms | 0.019ms | 11ms | 0.000ms | 14ms | 16ms | 41ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 4307 | 2 | 400:2 429:4305 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.021ms | 11ms | 0.000ms | 14ms | 16ms | 24ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 4051 | 0 | 200:2 429:4049 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 12ms | 0.020ms | 11ms | 0.000ms | 14ms | 16ms | 45ms |
| `POST /v1/tenants` | 4056 | 0 | 201:2 429:4054 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.021ms | 11ms | 0.000ms | 14ms | 16ms | 40ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 4116 | 0 | 429:4116 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.020ms | 11ms | 0.000ms | 14ms | 16ms | 24ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 4135 | 0 | 201:1 429:4134 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 12ms | 0.021ms | 11ms | 0.000ms | 14ms | 16ms | 57ms |
| `POST /v1/tenants/{id}/rooms` | 4122 | 0 | 201:3 429:4119 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 12ms | 0.020ms | 11ms | 0.000ms | 14ms | 16ms | 50ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 4431 | 2 | 400:2 429:4429 | 12ms | 0.000ms | 0.001ms | 0.000ms | 0.016ms | 12ms | 0.019ms | 11ms | 0.000ms | 14ms | 16ms | 24ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 4187 | 0 | 201:2 429:4185 | 12ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 12ms | 0.020ms | 11ms | 0.000ms | 14ms | 16ms | 52ms |

## Timing Shape

With `CHALK_API_OPERATION_LOGS=1`, server logs contain `http.request` events and Postgres adapter `db.query` operation events. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing. DB operation logs are intentionally not request-correlated.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_OPERATION_LOGS`, `CHALK_API_PROFILER`, and `CHALK_API_REQUEST_LOGS` unset. To strip it from the codebase later, remove `internal/observability`, the observability fields in config, the generic router middleware/profiler options, and `cmd/perf` plus `scripts/perf-local.sh`.
