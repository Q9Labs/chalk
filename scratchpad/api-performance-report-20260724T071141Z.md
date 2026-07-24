# Chalk API Local Performance Report

Generated: 2026-07-24T07:12:31Z

## Scope

- Seed tenants: 64
- Endpoints exercised: `/healthz`, `/readyz`, `/v1/me`, tenants, regions, rooms, room sessions, recordings, recording download URL edge, transcripts, and audit logs.
- Protected `/v1` requests use a perf-only bearer session seeded directly into the configured local Postgres database.
- Server log: local raw JSONL under `.private/`, not intended for commit.

## Lifecycle

| Measurement | Duration |
| --- | ---: |
| Startup to /healthz | 82ms |
| Startup to /readyz | 22ms |
| Graceful shutdown after SIGTERM | 7ms |

## Load Phase

- Duration: 20.019s
- Concurrency: 32
- Requests: 27535
- Errors: 1638
- Throughput: 1375.4 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 46.6 MiB |
| RSS mean | 44.0 MiB |
| CPU max | 98.9% |
| CPU mean | 72.0% |
| File descriptors max | 53 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 1858 | 0 | 200:1858 | 0.457ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 0.384ms | 0.040ms | 0.011ms | 0.000ms | 1ms | 4ms | 11ms |
| `GET /readyz` | 2784 | 0 | 200:2784 | 14ms | 0.000ms | 0.000ms | 0.000ms | 0.031ms | 13ms | 0.054ms | 13ms | 0.000ms | 29ms | 68ms | 259ms |
| `GET /v1/me` | 954 | 0 | 200:133 429:821 | 14ms | 0.000ms | 0.001ms | 0.000ms | 0.043ms | 14ms | 0.052ms | 14ms | 0.000ms | 28ms | 51ms | 267ms |
| `GET /v1/regions` | 1725 | 0 | 200:1725 | 15ms | 0.000ms | 0.000ms | 0.000ms | 0.037ms | 15ms | 0.053ms | 15ms | 0.000ms | 33ms | 70ms | 331ms |
| `GET /v1/tenants/{id}` | 1709 | 0 | 200:1709 | 42ms | 0.000ms | 0.001ms | 0.000ms | 0.039ms | 42ms | 0.059ms | 42ms | 0.000ms | 89ms | 163ms | 495ms |
| `GET /v1/tenants/{id}/audit-logs` | 813 | 0 | 200:813 | 42ms | 0.000ms | 0.001ms | 0.000ms | 0.039ms | 42ms | 0.052ms | 41ms | 0.000ms | 78ms | 136ms | 599ms |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 780 | 0 | 200:780 | 44ms | 0.000ms | 0.004ms | 0.000ms | 0.032ms | 44ms | 0.052ms | 44ms | 0.000ms | 96ms | 254ms | 499ms |
| `GET /v1/tenants/{id}/recordings` | 919 | 0 | 200:919 | 43ms | 0.000ms | 0.000ms | 0.000ms | 0.042ms | 43ms | 0.058ms | 43ms | 0.000ms | 85ms | 182ms | 491ms |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 869 | 0 | 200:869 | 44ms | 0.000ms | 0.001ms | 0.000ms | 0.041ms | 44ms | 0.068ms | 43ms | 0.000ms | 89ms | 193ms | 581ms |
| `GET /v1/tenants/{id}/rooms` | 946 | 0 | 200:946 | 45ms | 0.000ms | 0.000ms | 0.000ms | 0.031ms | 45ms | 0.053ms | 44ms | 0.000ms | 91ms | 171ms | 625ms |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 1011 | 0 | 200:1011 | 43ms | 0.000ms | 0.001ms | 0.000ms | 0.035ms | 43ms | 0.071ms | 43ms | 0.000ms | 86ms | 160ms | 601ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 939 | 0 | 200:939 | 44ms | 0.000ms | 0.002ms | 0.000ms | 0.032ms | 44ms | 0.055ms | 44ms | 0.000ms | 97ms | 237ms | 524ms |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 905 | 0 | 200:905 | 42ms | 0.000ms | 0.001ms | 0.000ms | 0.038ms | 41ms | 0.052ms | 41ms | 0.000ms | 84ms | 135ms | 619ms |
| `GET /v1/tenants/{id}/transcripts` | 806 | 806 | 503:806 | 15ms | 0.000ms | 0.002ms | 0.000ms | 0.034ms | 15ms | 0.054ms | 15ms | 0.000ms | 36ms | 61ms | 230ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 799 | 799 | 503:799 | 15ms | 0.000ms | 0.000ms | 0.000ms | 0.036ms | 15ms | 0.070ms | 14ms | 0.000ms | 31ms | 74ms | 221ms |
| `PATCH /v1/tenants/{id}` | 840 | 0 | 200:8 429:832 | 16ms | 0.000ms | 0.003ms | 0.000ms | 0.047ms | 16ms | 0.058ms | 16ms | 0.000ms | 30ms | 108ms | 397ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 879 | 0 | 200:8 429:871 | 16ms | 0.000ms | 0.003ms | 0.000ms | 0.055ms | 16ms | 0.052ms | 16ms | 0.000ms | 35ms | 118ms | 395ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 970 | 0 | 200:3 429:967 | 16ms | 0.000ms | 0.004ms | 0.000ms | 0.044ms | 16ms | 0.053ms | 16ms | 0.000ms | 33ms | 77ms | 422ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 909 | 10 | 400:10 429:899 | 15ms | 0.000ms | 0.000ms | 0.000ms | 0.060ms | 15ms | 0.061ms | 14ms | 0.000ms | 33ms | 53ms | 97ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 766 | 6 | 429:760 503:6 | 15ms | 0.000ms | 0.010ms | 0.000ms | 0.038ms | 15ms | 0.057ms | 15ms | 0.000ms | 31ms | 78ms | 288ms |
| `POST /v1/tenants` | 931 | 0 | 201:5 429:926 | 16ms | 0.000ms | 0.004ms | 0.000ms | 0.048ms | 16ms | 0.056ms | 16ms | 0.000ms | 33ms | 96ms | 385ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 853 | 0 | 429:849 503:4 | 14ms | 0.000ms | 0.000ms | 0.000ms | 0.037ms | 14ms | 0.050ms | 14ms | 0.000ms | 31ms | 56ms | 155ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 824 | 7 | 429:817 503:7 | 15ms | 0.000ms | 0.000ms | 0.000ms | 0.038ms | 15ms | 0.057ms | 15ms | 0.000ms | 35ms | 65ms | 357ms |
| `POST /v1/tenants/{id}/rooms` | 915 | 0 | 201:7 429:908 | 18ms | 0.000ms | 0.000ms | 0.000ms | 0.042ms | 18ms | 0.053ms | 17ms | 0.000ms | 33ms | 143ms | 579ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 950 | 10 | 400:10 429:940 | 15ms | 0.000ms | 0.000ms | 0.000ms | 0.057ms | 15ms | 0.051ms | 15ms | 0.000ms | 32ms | 65ms | 426ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 881 | 0 | 201:11 429:870 | 16ms | 0.000ms | 0.006ms | 0.000ms | 0.045ms | 16ms | 0.059ms | 16ms | 0.000ms | 30ms | 95ms | 357ms |

## Stress Phase

- Duration: 20.067s
- Concurrency: 128
- Requests: 24044
- Errors: 1518
- Throughput: 1198.2 req/s

| Process metric | Value |
| --- | ---: |
| RSS max | 53.6 MiB |
| RSS mean | 51.5 MiB |
| CPU max | 98.1% |
| CPU mean | 65.4% |
| File descriptors max | 159 |

| Endpoint | Count | Errors | Statuses | Client mean | DNS | Connect | TLS | Write | Wait first byte | Read | Server | DB | p95 | p99 | Max |
| --- | ---: | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `GET /healthz` | 1840 | 0 | 200:1840 | 0.527ms | 0.000ms | 0.006ms | 0.000ms | 0.059ms | 0.404ms | 0.057ms | 0.012ms | 0.000ms | 1ms | 5ms | 28ms |
| `GET /readyz` | 2643 | 0 | 200:2643 | 68ms | 0.000ms | 0.005ms | 0.000ms | 0.039ms | 68ms | 0.060ms | 67ms | 0.000ms | 151ms | 301ms | 803ms |
| `GET /v1/me` | 824 | 0 | 200:33 429:791 | 71ms | 0.000ms | 0.010ms | 0.000ms | 0.035ms | 71ms | 0.056ms | 71ms | 0.000ms | 184ms | 378ms | 797ms |
| `GET /v1/regions` | 1394 | 0 | 200:1394 | 69ms | 0.000ms | 0.006ms | 0.000ms | 0.035ms | 69ms | 0.059ms | 69ms | 0.000ms | 134ms | 302ms | 771ms |
| `GET /v1/tenants/{id}` | 1482 | 0 | 200:1482 | 211ms | 0.000ms | 0.007ms | 0.000ms | 0.046ms | 211ms | 0.051ms | 211ms | 0.000ms | 490ms | 1.057s | 1.217s |
| `GET /v1/tenants/{id}/audit-logs` | 723 | 0 | 200:723 | 206ms | 0.000ms | 0.007ms | 0.000ms | 0.077ms | 205ms | 0.057ms | 205ms | 0.000ms | 420ms | 1.033s | 1.197s |
| `GET /v1/tenants/{id}/audit-logs/{audit_log_id}` | 748 | 0 | 200:748 | 208ms | 0.000ms | 0.001ms | 0.000ms | 0.044ms | 208ms | 0.052ms | 207ms | 0.000ms | 496ms | 1.018s | 1.162s |
| `GET /v1/tenants/{id}/recordings` | 796 | 0 | 200:796 | 202ms | 0.000ms | 0.002ms | 0.000ms | 0.036ms | 202ms | 0.070ms | 202ms | 0.000ms | 384ms | 901ms | 1.315s |
| `GET /v1/tenants/{id}/recordings/{recording_id}` | 732 | 0 | 200:732 | 194ms | 0.000ms | 0.000ms | 0.000ms | 0.032ms | 194ms | 0.049ms | 194ms | 0.000ms | 343ms | 829ms | 1.199s |
| `GET /v1/tenants/{id}/rooms` | 686 | 0 | 200:686 | 208ms | 0.000ms | 0.006ms | 0.000ms | 0.038ms | 207ms | 0.097ms | 207ms | 0.000ms | 499ms | 1.119s | 1.204s |
| `GET /v1/tenants/{id}/rooms/{room_id}` | 743 | 0 | 200:743 | 210ms | 0.000ms | 0.004ms | 0.000ms | 0.032ms | 210ms | 0.047ms | 210ms | 0.000ms | 484ms | 1.007s | 1.228s |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions` | 791 | 0 | 200:791 | 210ms | 0.000ms | 0.001ms | 0.000ms | 0.051ms | 210ms | 0.053ms | 209ms | 0.000ms | 491ms | 1.028s | 1.139s |
| `GET /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 773 | 0 | 200:773 | 204ms | 0.000ms | 0.001ms | 0.000ms | 0.036ms | 204ms | 0.053ms | 203ms | 0.000ms | 360ms | 1.137s | 1.284s |
| `GET /v1/tenants/{id}/transcripts` | 767 | 767 | 503:767 | 68ms | 0.000ms | 0.001ms | 0.000ms | 0.033ms | 68ms | 0.052ms | 67ms | 0.000ms | 165ms | 278ms | 492ms |
| `GET /v1/tenants/{id}/transcripts/{transcript_id}` | 744 | 744 | 503:744 | 67ms | 0.000ms | 0.017ms | 0.000ms | 0.042ms | 67ms | 0.054ms | 66ms | 0.000ms | 133ms | 285ms | 587ms |
| `PATCH /v1/tenants/{id}` | 751 | 0 | 200:3 429:748 | 71ms | 0.000ms | 0.002ms | 0.000ms | 0.051ms | 71ms | 0.052ms | 70ms | 0.000ms | 172ms | 374ms | 575ms |
| `PATCH /v1/tenants/{id}/recordings/{recording_id}` | 752 | 0 | 200:2 429:750 | 73ms | 0.000ms | 0.006ms | 0.000ms | 0.048ms | 73ms | 0.063ms | 72ms | 0.000ms | 178ms | 477ms | 835ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}` | 745 | 0 | 200:4 429:741 | 69ms | 0.000ms | 0.004ms | 0.000ms | 0.052ms | 68ms | 0.054ms | 68ms | 0.000ms | 134ms | 314ms | 610ms |
| `PATCH /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}` | 760 | 1 | 400:1 429:759 | 67ms | 0.000ms | 0.010ms | 0.000ms | 0.090ms | 67ms | 0.064ms | 67ms | 0.000ms | 154ms | 302ms | 585ms |
| `PATCH /v1/tenants/{id}/transcripts/{transcript_id}` | 782 | 2 | 429:780 503:2 | 68ms | 0.000ms | 0.012ms | 0.000ms | 0.065ms | 68ms | 0.056ms | 68ms | 0.000ms | 133ms | 301ms | 749ms |
| `POST /v1/tenants` | 732 | 0 | 201:1 429:731 | 69ms | 0.000ms | 0.003ms | 0.000ms | 0.050ms | 69ms | 0.049ms | 68ms | 0.000ms | 148ms | 283ms | 799ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/download-url` | 726 | 0 | 429:724 503:2 | 68ms | 0.000ms | 0.000ms | 0.000ms | 0.041ms | 68ms | 0.055ms | 67ms | 0.000ms | 134ms | 290ms | 738ms |
| `POST /v1/tenants/{id}/recordings/{recording_id}/transcripts` | 740 | 3 | 429:737 503:3 | 72ms | 0.000ms | 0.000ms | 0.000ms | 0.050ms | 72ms | 0.072ms | 71ms | 0.000ms | 148ms | 456ms | 761ms |
| `POST /v1/tenants/{id}/rooms` | 698 | 0 | 429:698 | 73ms | 0.000ms | 0.002ms | 0.000ms | 0.042ms | 73ms | 0.063ms | 73ms | 0.000ms | 158ms | 315ms | 795ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions` | 807 | 1 | 400:1 429:806 | 72ms | 0.000ms | 0.006ms | 0.000ms | 0.058ms | 71ms | 0.067ms | 71ms | 0.000ms | 181ms | 375ms | 593ms |
| `POST /v1/tenants/{id}/rooms/{room_id}/sessions/{session_id}/recordings` | 865 | 0 | 201:2 429:863 | 66ms | 0.000ms | 0.009ms | 0.000ms | 0.068ms | 66ms | 0.056ms | 66ms | 0.000ms | 130ms | 254ms | 887ms |

## Timing Shape

With `CHALK_API_OPERATION_LOGS=1`, server logs contain `http.request` events and Postgres adapter `db.query` operation events. Client-side timings come from Go `httptrace`: connect, write, first byte, total response read. Local HTTP has no TLS timing. DB operation logs are intentionally not request-correlated.

## Teardown

The reusable observability layer is opt-in. To disable it, leave `CHALK_API_OPERATION_LOGS`, `CHALK_API_PROFILER`, and `CHALK_API_REQUEST_LOGS` unset. To strip it from the codebase later, remove `internal/observability`, the observability fields in config, the generic router middleware/profiler options, and `cmd/perf` plus `scripts/perf-local.sh`.
