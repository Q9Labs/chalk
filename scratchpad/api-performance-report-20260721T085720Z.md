# Chalk API Local Performance Report

Generated: 2026-07-21T08:58:25Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `/v1/me`, tenants, regions, rooms, room sessions, recordings, recording download URL edge, transcripts, and audit logs.
- Protected `/v1` requests use a perf-only bearer session seeded directly into the configured local Postgres database.
- Server log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 862ms |
| Startup to /readyz | 0.369ms |
| Graceful shutdown after SIGTERM | 6ms |

## Load Phase

- Duration: 20.002s
- Concurrency: 32
- Requests: 238199
- Errors: 35
- Throughput: 11908.9 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 50.2 MiB |
| RSS mean | 48.8 MiB |
| CPU max | 229.0% |
| CPU mean | 194.1% |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 14904 | 0 | 200:14904 | 0.185ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 0.159ms | 0.013ms | 0.003ms | 0.000ms | 0.464ms | 1ms | 63ms |
| `GET /readyz` | 22498 | 0 | 200:22498 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.011ms | 1ms | 0.021ms | 1ms | 0.000ms | 2ms | 4ms | 70ms |
| `GET /v1/me` | 9606 | 0 | 200:133 429:9473 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 2ms | 0.023ms | 1ms | 0.000ms | 3ms | 4ms | 41ms |
| `GET /v1/regions` | 16044 | 0 | 200:16044 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 2ms | 0.022ms | 1ms | 0.000ms | 3ms | 4ms | 101ms |
| `GET /v1/tenants/{id}` | 15459 | 0 | 200:15459 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 4ms | 0.024ms | 4ms | 0.000ms | 7ms | 12ms | 106ms |
| `GET /v1/tenants/{id}/audit-logs` | 7028 | 0 | 200:7028 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 5ms | 0.024ms | 4ms | 0.000ms | 7ms | 12ms | 104ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 6966 | 0 | 200:6966 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 5ms | 0.027ms | 4ms | 0.000ms | 7ms | 12ms | 103ms |
| `GET /v1/tenants/{id}/recordings` | 8105 | 0 | 200:8105 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 5ms | 0.024ms | 4ms | 0.000ms | 7ms | 12ms | 105ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 8115 | 0 | 200:8115 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 5ms | 0.023ms | 4ms | 0.000ms | 7ms | 12ms | 104ms |
| `GET /v1/tenants/{id}/rooms` | 7694 | 0 | 200:7694 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.012ms | 5ms | 0.023ms | 4ms | 0.000ms | 7ms | 12ms | 103ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 7556 | 0 | 200:7556 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 4ms | 0.024ms | 4ms | 0.000ms | 7ms | 11ms | 104ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 7480 | 0 | 200:7480 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 5ms | 0.023ms | 4ms | 0.000ms | 7ms | 11ms | 104ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 7627 | 0 | 200:7627 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 4ms | 0.024ms | 4ms | 0.000ms | 7ms | 11ms | 103ms |
| `GET /v1/tenants/{id}/transcripts` | 7733 | 0 | 200:7733 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 5ms | 0.028ms | 4ms | 0.000ms | 7ms | 11ms | 68ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 7400 | 0 | 200:7400 | 5ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 5ms | 0.024ms | 4ms | 0.000ms | 7ms | 12ms | 104ms |
| `PATCH /v1/tenants/{id}` | 7544 | 0 | 200:6 429:7538 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.021ms | 2ms | 0.000ms | 3ms | 5ms | 101ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 8004 | 0 | 200:5 429:7999 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.022ms | 2ms | 0.000ms | 3ms | 4ms | 75ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 7282 | 0 | 200:9 429:7273 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.023ms | 1ms | 0.000ms | 3ms | 4ms | 75ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 7792 | 6 | 400:6 429:7786 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 2ms | 0.023ms | 1ms | 0.000ms | 3ms | 4ms | 101ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 7274 | 6 | 429:7268 500:6 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.023ms | 2ms | 0.000ms | 3ms | 4ms | 66ms |
| `POST /v1/tenants` | 7564 | 0 | 201:8 429:7556 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.014ms | 2ms | 0.022ms | 2ms | 0.000ms | 3ms | 5ms | 68ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 7903 | 0 | 429:7898 503:5 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.022ms | 2ms | 0.000ms | 3ms | 4ms | 101ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 7284 | 13 | 429:7271 500:13 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.022ms | 2ms | 0.000ms | 3ms | 5ms | 68ms |
| `POST /v1/tenants/{id}/rooms` | 7508 | 0 | 201:4 429:7504 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.021ms | 2ms | 0.000ms | 3ms | 5ms | 65ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 7739 | 10 | 400:10 429:7729 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.016ms | 2ms | 0.021ms | 1ms | 0.000ms | 3ms | 4ms | 101ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 8090 | 0 | 201:7 429:8083 | 2ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 2ms | 0.024ms | 2ms | 0.000ms | 3ms | 4ms | 66ms |

## Stress Phase

- Duration: 20.009s
- Concurrency: 128
- Requests: 239823
- Errors: 7
- Throughput: 11985.7 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 60.2 MiB |
| RSS mean | 57.5 MiB |
| CPU max | 238.8% |
| CPU mean | 210.8% |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 15461 | 0 | 200:15461 | 0.216ms | 0.000ms | 0.000ms | 0.000ms | 0.010ms | 0.192ms | 0.011ms | 0.003ms | 0.000ms | 0.601ms | 2ms | 53ms |
| `GET /readyz` | 23043 | 0 | 200:23043 | 6ms | 0.000ms | 0.001ms | 0.000ms | 0.010ms | 6ms | 0.016ms | 6ms | 0.000ms | 10ms | 16ms | 65ms |
| `GET /v1/me` | 9943 | 0 | 200:33 429:9910 | 6ms | 0.000ms | 0.000ms | 0.000ms | 0.013ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 16ms | 66ms |
| `GET /v1/regions` | 16414 | 0 | 200:16414 | 6ms | 0.000ms | 0.000ms | 0.000ms | 0.011ms | 6ms | 0.017ms | 6ms | 0.000ms | 10ms | 16ms | 67ms |
| `GET /v1/tenants/{id}` | 15265 | 0 | 200:15265 | 19ms | 0.000ms | 0.000ms | 0.000ms | 0.011ms | 19ms | 0.018ms | 18ms | 0.000ms | 29ms | 45ms | 107ms |
| `GET /v1/tenants/{id}/audit-logs` | 7520 | 0 | 200:7520 | 19ms | 0.000ms | 0.002ms | 0.000ms | 0.012ms | 19ms | 0.018ms | 18ms | 0.000ms | 29ms | 42ms | 89ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 7341 | 0 | 200:7341 | 19ms | 0.000ms | 0.001ms | 0.000ms | 0.010ms | 19ms | 0.018ms | 18ms | 0.000ms | 29ms | 43ms | 104ms |
| `GET /v1/tenants/{id}/recordings` | 7769 | 0 | 200:7769 | 19ms | 0.000ms | 0.001ms | 0.000ms | 0.012ms | 19ms | 0.017ms | 19ms | 0.000ms | 29ms | 42ms | 103ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 7760 | 0 | 200:7760 | 19ms | 0.000ms | 0.004ms | 0.000ms | 0.012ms | 19ms | 0.017ms | 18ms | 0.000ms | 28ms | 44ms | 105ms |
| `GET /v1/tenants/{id}/rooms` | 7573 | 0 | 200:7573 | 19ms | 0.000ms | 0.002ms | 0.000ms | 0.012ms | 19ms | 0.019ms | 18ms | 0.000ms | 29ms | 44ms | 99ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 7413 | 0 | 200:7413 | 19ms | 0.000ms | 0.000ms | 0.000ms | 0.011ms | 19ms | 0.018ms | 19ms | 0.000ms | 29ms | 44ms | 110ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 7705 | 0 | 200:7705 | 19ms | 0.000ms | 0.001ms | 0.000ms | 0.014ms | 19ms | 0.018ms | 18ms | 0.000ms | 29ms | 44ms | 105ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 7694 | 0 | 200:7694 | 19ms | 0.000ms | 0.002ms | 0.000ms | 0.012ms | 19ms | 0.017ms | 19ms | 0.000ms | 29ms | 48ms | 105ms |
| `GET /v1/tenants/{id}/transcripts` | 7691 | 0 | 200:7691 | 19ms | 0.000ms | 0.003ms | 0.000ms | 0.010ms | 19ms | 0.019ms | 18ms | 0.000ms | 29ms | 44ms | 101ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 7533 | 0 | 200:7533 | 19ms | 0.000ms | 0.000ms | 0.000ms | 0.010ms | 19ms | 0.019ms | 18ms | 0.000ms | 29ms | 45ms | 99ms |
| `PATCH /v1/tenants/{id}` | 7454 | 0 | 200:1 429:7453 | 6ms | 0.000ms | 0.002ms | 0.000ms | 0.012ms | 6ms | 0.016ms | 6ms | 0.000ms | 10ms | 19ms | 68ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 7641 | 0 | 200:3 429:7638 | 6ms | 0.000ms | 0.003ms | 0.000ms | 0.014ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 17ms | 69ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 7737 | 0 | 200:5 429:7732 | 6ms | 0.000ms | 0.002ms | 0.000ms | 0.013ms | 6ms | 0.017ms | 6ms | 0.000ms | 10ms | 17ms | 66ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 7818 | 0 | 429:7818 | 6ms | 0.000ms | 0.004ms | 0.000ms | 0.014ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 18ms | 65ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 7423 | 3 | 429:7420 500:3 | 6ms | 0.000ms | 0.002ms | 0.000ms | 0.015ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 18ms | 68ms |
| `POST /v1/tenants` | 7567 | 0 | 201:2 429:7565 | 6ms | 0.000ms | 0.002ms | 0.000ms | 0.013ms | 6ms | 0.017ms | 6ms | 0.000ms | 10ms | 18ms | 65ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 7588 | 0 | 429:7585 503:3 | 6ms | 0.000ms | 0.000ms | 0.000ms | 0.015ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 17ms | 68ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 7447 | 3 | 429:7444 500:3 | 6ms | 0.000ms | 0.001ms | 0.000ms | 0.013ms | 6ms | 0.020ms | 6ms | 0.000ms | 10ms | 18ms | 101ms |
| `POST /v1/tenants/{id}/rooms` | 7624 | 0 | 429:7624 | 6ms | 0.000ms | 0.001ms | 0.000ms | 0.016ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 18ms | 66ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 7709 | 1 | 400:1 429:7708 | 6ms | 0.000ms | 0.001ms | 0.000ms | 0.012ms | 6ms | 0.017ms | 6ms | 0.000ms | 10ms | 16ms | 70ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 7690 | 0 | 429:7690 | 6ms | 0.000ms | 0.001ms | 0.000ms | 0.015ms | 6ms | 0.018ms | 6ms | 0.000ms | 10ms | 18ms | 65ms |

## Timing Shape

With `CHALK_API_OPERATION_LOGS=1`, server logs contain `http.request` events and Postgres adapter `db.query` operation events. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing. DB operation logs are intentionally not request-correlated.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_OPERATION_LOGS`, `CHALK_API_PROFILER`, and `CHALK_API_REQUEST_LOGS` unset. To strip it from the codebase later, remove `internal/observability`, the observability fields in config, the generic router middleware/profiler options, and `cmd/perf` plus `scripts/perf-local.sh`.
