# API Performance Pool Sweep - 2026-06-30

## Setup

- Workload: mixed read/write API traffic with trace logs enabled.
- Endpoints: `/healthz`, `/readyz`, `GET /v1/regions`, `GET /v1/tenants`, `POST /v1/tenants`, `GET /v1/tenants/{id}`, `PATCH /v1/tenants/{id}`.
- Phases per run: 15s load at concurrency 32, then 15s stress at concurrency 90.
- Local Postgres: `max_connections=100`, `shared_buffers=128MB`.
- Local macOS limits observed: `ulimit -n=256`, `kern.ipc.somaxconn=128`.
- Tenant rows after the sweep: about 223k plus follow-up run inserts.

## Stress Results

| API DB pool | Throughput | RSS max | CPU mean | FD max | Read means | Write means | Write p99 | Write max |
| ---: | ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 10 | 11,461.6 req/s | 35.6 MiB | 203.9% | 137 | list 11ms, get 10ms | patch 13ms, post 13ms | patch 21ms, post 20ms | patch 41ms, post 41ms |
| 16 | 12,472.1 req/s | 38.2 MiB | 203.0% | 128 | list 10ms, get 9ms | patch 13ms, post 13ms | patch 21ms, post 21ms | patch 46ms, post 44ms |
| 24 | 12,480.7 req/s | 39.8 MiB | 199.3% | 135 | list 9ms, get 9ms | patch 15ms, post 15ms | patch 26ms, post 24ms | patch 56ms, post 50ms |
| 32 | 12,770.9 req/s | 43.4 MiB | 204.9% | 162 | list 9ms, get 8ms | patch 17ms, post 17ms | patch 32ms, post 31ms | patch 73ms, post 69ms |
| 90 | 10,689.1 req/s | 59.6 MiB | 164.3% | 214 | list 7ms, get 4ms | patch 48ms, post 37ms | patch 144ms, post 82ms | patch 1.254s, post 1.366s |

## Interpretation

- Pool 90 is worse overall: it uses the most memory and file descriptors, lowers throughput, and creates second-scale write outliers.
- Pool 32 has the highest throughput, but write latency tails widen materially compared with pools 16 and 24.
- Pool 16 is the best local default candidate from this sweep: it recovers most of the throughput gain over pool 10 while keeping write means and p99s close to pool 10.
- Pool 24 is acceptable if slightly higher read throughput matters more than write tail latency.

## Query Shape Check

The current tenant paths have the right indexes for the exercised API shapes:

- `tenants_pkey` handles `GET /v1/tenants/{id}` and `PATCH /v1/tenants/{id}`.
- `tenants_created_at_id_idx` handles `GET /v1/tenants` ordering and cursor pagination.

Representative local `EXPLAIN (ANALYZE, BUFFERS)` results after `ANALYZE tenants`:

- Primary-key get: index scan on `tenants_pkey`, about 0.150ms execution.
- Primary-key update: index scan on `tenants_pkey`, about 0.388ms execution.
- First list page: index scan on `tenants_created_at_id_idx`, about 0.052ms execution.
- Cursor list page near offset 500: index scan on `tenants_created_at_id_idx`, about 0.226ms execution.
- Insert returning: about 0.227ms execution.

The multi-millisecond DB bucket in the API reports is therefore not explained by a missing tenant index. It includes pool acquisition, SQL roundtrip, row scan/mapping, mixed write pressure, local Postgres/container overhead, and trace logging.

## Artifacts

- Pool 10: `apps/api/scratchpad/api-performance-pool10-c90.html`
- Pool 16: `apps/api/scratchpad/api-performance-pool16-c90.html`
- Pool 24: `apps/api/scratchpad/api-performance-pool24-c90.html`
- Pool 32: `apps/api/scratchpad/api-performance-pool32-c90.html`
- Pool 90: `apps/api/scratchpad/api-performance-pool90-c90.html`

Raw trace logs are under `apps/api/.private/api-perf-pool*-c90/` and are intentionally local-only.
