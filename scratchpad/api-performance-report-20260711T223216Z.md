# Chalk API Local Performance Report

Generated: 2026-07-11T22:33:07Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `/v1/me`, tenants, regions, rooms, room sessions, recordings, recording download URL edge, transcripts, and audit logs.
- Protected `/v1` requests use a perf-only bearer session seeded directly into the configured local Postgres database.
- Server log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 1.028s |
| Startup to /readyz | 1ms |
| Graceful shutdown after SIGTERM | 10ms |

## Load Phase

- Duration: 20.007s
- Concurrency: 32
- Requests: 124654
- Errors: 18
- Throughput: 6230.4 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 42.0 MiB |
| RSS mean | 40.5 MiB |
| CPU max | 170.4% |
| CPU mean | 145.5% |
| File descriptors max | 54 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 8119 | 0 | 200:8119 | 0.234ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 0.196ms | 0.019ms | 0.004ms | 0.000ms | 0.610ms | 1ms | 9ms |
| `GET /readyz` | 12533 | 0 | 200:12533 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.018ms | 3ms | 0.034ms | 3ms | 0.000ms | 4ms | 6ms | 17ms |
| `GET /v1/me` | 4605 | 0 | 200:133 429:4472 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 3ms | 0.037ms | 3ms | 0.000ms | 5ms | 6ms | 41ms |
| `GET /v1/regions` | 8076 | 0 | 200:8076 | 3ms | 0.000ms | 0.001ms | 0.000ms | 0.021ms | 3ms | 0.035ms | 3ms | 0.000ms | 5ms | 7ms | 44ms |
| `GET /v1/tenants/{id}` | 8001 | 0 | 200:8001 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.023ms | 9ms | 0.042ms | 8ms | 0.000ms | 12ms | 15ms | 67ms |
| `GET /v1/tenants/{id}/audit-logs` | 3575 | 0 | 200:3575 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.026ms | 9ms | 0.048ms | 9ms | 0.000ms | 13ms | 16ms | 69ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 3380 | 0 | 200:3380 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 9ms | 0.042ms | 9ms | 0.000ms | 12ms | 15ms | 34ms |
| `GET /v1/tenants/{id}/recordings` | 4360 | 0 | 200:4360 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.024ms | 9ms | 0.040ms | 9ms | 0.000ms | 13ms | 15ms | 75ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 4332 | 0 | 200:4332 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.020ms | 9ms | 0.043ms | 9ms | 0.000ms | 12ms | 15ms | 31ms |
| `GET /v1/tenants/{id}/rooms` | 4016 | 0 | 200:4016 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 9ms | 0.043ms | 9ms | 0.000ms | 13ms | 16ms | 63ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 3885 | 0 | 200:3885 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.023ms | 9ms | 0.037ms | 9ms | 0.000ms | 12ms | 15ms | 37ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 3920 | 0 | 200:3920 | 9ms | 0.000ms | 0.001ms | 0.000ms | 0.022ms | 9ms | 0.042ms | 9ms | 0.000ms | 13ms | 15ms | 68ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 3988 | 0 | 200:3988 | 9ms | 0.000ms | 0.002ms | 0.000ms | 0.024ms | 9ms | 0.043ms | 9ms | 0.000ms | 12ms | 15ms | 55ms |
| `GET /v1/tenants/{id}/transcripts` | 3939 | 0 | 200:3939 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 9ms | 0.046ms | 9ms | 0.000ms | 13ms | 15ms | 33ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 3819 | 0 | 200:3819 | 9ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 9ms | 0.045ms | 9ms | 0.000ms | 12ms | 15ms | 62ms |
| `PATCH /v1/tenants/{id}` | 4012 | 0 | 200:4 429:4008 | 3ms | 0.000ms | 0.001ms | 0.000ms | 0.025ms | 3ms | 0.040ms | 3ms | 0.000ms | 5ms | 6ms | 72ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 4245 | 0 | 200:8 429:4237 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.025ms | 3ms | 0.038ms | 3ms | 0.000ms | 5ms | 7ms | 71ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 3928 | 0 | 200:10 429:3918 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.030ms | 3ms | 0.040ms | 3ms | 0.000ms | 5ms | 7ms | 74ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 4332 | 9 | 400:9 429:4323 | 3ms | 0.000ms | 0.002ms | 0.000ms | 0.027ms | 3ms | 0.040ms | 3ms | 0.000ms | 5ms | 7ms | 40ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 3648 | 0 | 200:3 429:3645 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.026ms | 3ms | 0.035ms | 3ms | 0.000ms | 5ms | 6ms | 38ms |
| `POST /v1/tenants` | 3896 | 0 | 201:5 429:3891 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 3ms | 0.037ms | 3ms | 0.000ms | 5ms | 7ms | 57ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 3962 | 0 | 429:3956 503:6 | 3ms | 0.000ms | 0.002ms | 0.000ms | 0.028ms | 3ms | 0.039ms | 3ms | 0.000ms | 5ms | 7ms | 50ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 3715 | 0 | 201:10 429:3705 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.028ms | 3ms | 0.032ms | 3ms | 0.000ms | 5ms | 7ms | 73ms |
| `POST /v1/tenants/{id}/rooms` | 3971 | 0 | 201:6 429:3965 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.027ms | 3ms | 0.037ms | 3ms | 0.000ms | 5ms | 7ms | 26ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 4144 | 9 | 400:9 429:4135 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.024ms | 3ms | 0.037ms | 3ms | 0.000ms | 5ms | 6ms | 14ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 4253 | 0 | 201:9 429:4244 | 3ms | 0.000ms | 0.000ms | 0.000ms | 0.030ms | 3ms | 0.038ms | 3ms | 0.000ms | 5ms | 8ms | 41ms |

## Stress Phase

- Duration: 20.024s
- Concurrency: 128
- Requests: 118940
- Errors: 11
- Throughput: 5940.0 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 50.2 MiB |
| RSS mean | 49.6 MiB |
| CPU max | 162.1% |
| CPU mean | 144.6% |
| File descriptors max | 158 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 7970 | 0 | 200:7970 | 0.398ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 0.357ms | 0.018ms | 0.007ms | 0.000ms | 1ms | 4ms | 63ms |
| `GET /readyz` | 12142 | 0 | 200:12142 | 12ms | 0.000ms | 0.001ms | 0.000ms | 0.019ms | 12ms | 0.045ms | 12ms | 0.000ms | 20ms | 35ms | 180ms |
| `GET /v1/me` | 4550 | 0 | 200:33 429:4517 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.022ms | 13ms | 0.051ms | 13ms | 0.000ms | 22ms | 40ms | 182ms |
| `GET /v1/regions` | 7800 | 0 | 200:7800 | 13ms | 0.000ms | 0.001ms | 0.000ms | 0.025ms | 13ms | 0.047ms | 13ms | 0.000ms | 21ms | 39ms | 183ms |
| `GET /v1/tenants/{id}` | 7415 | 0 | 200:7415 | 38ms | 0.000ms | 0.001ms | 0.000ms | 0.026ms | 38ms | 0.055ms | 37ms | 0.000ms | 62ms | 86ms | 201ms |
| `GET /v1/tenants/{id}/audit-logs` | 3668 | 0 | 200:3668 | 38ms | 0.000ms | 0.000ms | 0.000ms | 0.019ms | 38ms | 0.045ms | 37ms | 0.000ms | 61ms | 81ms | 203ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 3687 | 0 | 200:3687 | 38ms | 0.000ms | 0.004ms | 0.000ms | 0.027ms | 38ms | 0.052ms | 38ms | 0.000ms | 66ms | 88ms | 203ms |
| `GET /v1/tenants/{id}/recordings` | 3873 | 0 | 200:3873 | 38ms | 0.000ms | 0.001ms | 0.000ms | 0.023ms | 38ms | 0.040ms | 37ms | 0.000ms | 61ms | 83ms | 201ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 3920 | 0 | 200:3920 | 38ms | 0.000ms | 0.001ms | 0.000ms | 0.024ms | 38ms | 0.049ms | 37ms | 0.000ms | 61ms | 85ms | 196ms |
| `GET /v1/tenants/{id}/rooms` | 3689 | 0 | 200:3689 | 38ms | 0.000ms | 0.000ms | 0.000ms | 0.025ms | 38ms | 0.045ms | 37ms | 0.000ms | 60ms | 83ms | 202ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 3786 | 0 | 200:3786 | 38ms | 0.000ms | 0.000ms | 0.000ms | 0.021ms | 38ms | 0.050ms | 38ms | 0.000ms | 62ms | 84ms | 204ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 3822 | 0 | 200:3822 | 38ms | 0.000ms | 0.000ms | 0.000ms | 0.024ms | 38ms | 0.050ms | 37ms | 0.000ms | 61ms | 83ms | 200ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 3843 | 0 | 200:3843 | 38ms | 0.000ms | 0.000ms | 0.000ms | 0.023ms | 38ms | 0.048ms | 37ms | 0.000ms | 61ms | 82ms | 195ms |
| `GET /v1/tenants/{id}/transcripts` | 3715 | 0 | 200:3715 | 37ms | 0.000ms | 0.001ms | 0.000ms | 0.024ms | 37ms | 0.042ms | 37ms | 0.000ms | 61ms | 80ms | 194ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 3671 | 0 | 200:3671 | 38ms | 0.000ms | 0.001ms | 0.000ms | 0.030ms | 38ms | 0.047ms | 37ms | 0.000ms | 60ms | 84ms | 196ms |
| `PATCH /v1/tenants/{id}` | 3761 | 0 | 200:1 429:3760 | 13ms | 0.000ms | 0.001ms | 0.000ms | 0.030ms | 13ms | 0.045ms | 13ms | 0.000ms | 21ms | 35ms | 180ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 3666 | 0 | 200:2 429:3664 | 13ms | 0.000ms | 0.001ms | 0.000ms | 0.025ms | 13ms | 0.049ms | 13ms | 0.000ms | 22ms | 41ms | 179ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 3818 | 0 | 429:3818 | 13ms | 0.000ms | 0.001ms | 0.000ms | 0.028ms | 13ms | 0.049ms | 12ms | 0.000ms | 21ms | 34ms | 181ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 3814 | 8 | 400:8 429:3806 | 13ms | 0.000ms | 0.001ms | 0.000ms | 0.032ms | 13ms | 0.062ms | 13ms | 0.000ms | 22ms | 38ms | 181ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 3595 | 0 | 429:3595 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.029ms | 13ms | 0.049ms | 13ms | 0.000ms | 22ms | 40ms | 182ms |
| `POST /v1/tenants` | 3829 | 0 | 201:2 429:3827 | 13ms | 0.000ms | 0.002ms | 0.000ms | 0.030ms | 13ms | 0.044ms | 12ms | 0.000ms | 21ms | 37ms | 181ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 3827 | 0 | 429:3825 503:2 | 13ms | 0.000ms | 0.002ms | 0.000ms | 0.031ms | 13ms | 0.045ms | 13ms | 0.000ms | 21ms | 39ms | 178ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 3607 | 0 | 429:3607 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.026ms | 13ms | 0.049ms | 12ms | 0.000ms | 21ms | 38ms | 180ms |
| `POST /v1/tenants/{id}/rooms` | 3872 | 0 | 201:2 429:3870 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.028ms | 13ms | 0.056ms | 12ms | 0.000ms | 21ms | 35ms | 181ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 3869 | 3 | 400:3 429:3866 | 13ms | 0.000ms | 0.003ms | 0.000ms | 0.027ms | 13ms | 0.047ms | 13ms | 0.000ms | 22ms | 41ms | 178ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 3731 | 0 | 201:1 429:3730 | 13ms | 0.000ms | 0.000ms | 0.000ms | 0.026ms | 13ms | 0.046ms | 13ms | 0.000ms | 21ms | 38ms | 183ms |

## Timing Shape

With `CHALK_API_OPERATION_LOGS=1`, server logs contain `http.request` events and Postgres adapter `db.query` operation events. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing. DB operation logs are intentionally not request-correlated.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_OPERATION_LOGS`, `CHALK_API_PROFILER`, and `CHALK_API_REQUEST_LOGS` unset. To strip it from the codebase later, remove `internal/observability`, the observability fields in config, the generic router middleware/profiler options, and `cmd/perf` plus `scripts/perf-local.sh`.
