# Agent Browser Join Stress

Join many Chalk rooms via `agent-browser` and measure:
- join latency distribution
- success/error rate
- failure reasons with per-attempt evidence

## Run

```bash
bash tests/scripts/run-agent-browser-join-stress.sh
```

Defaults:
- `--count 100`
- `--concurrency 2` (laptop-safe)
- `--artifact-mode failures-only`
- `--success-sample-percent 10`
- `--base-url https://chalk.q9labs.ai`

Example:

```bash
bash tests/scripts/run-agent-browser-join-stress.sh --count 100 --concurrency 4
```

Extra safe mode for 16GB laptops:

```bash
bash tests/scripts/run-agent-browser-join-stress.sh --count 100 --safe
```

Full-trace safe mode (captures detailed artifacts for every attempt + correlation map):

```bash
bash tests/scripts/run-agent-browser-join-stress.sh --count 100 --safe --full-trace
```

Chaos repro suite (deterministic incident paths + support-code capture):

```bash
bash tests/scripts/run-agent-browser-chaos.sh
```

Optional:

```bash
bash tests/scripts/run-agent-browser-chaos.sh --scenarios prejoin_offline,post_join_offline
```

## Outputs

Each run writes to:

`tests/results/agent-browser-join/<timestamp>/`

Main artifacts:
- `summary.json`
- `report.md`
- `results.ndjson`
- `correlation-map.ndjson`
- `correlation-map.json`
- `attempt-XXXX/console.json`
- `attempt-XXXX/errors.json`
- `attempt-XXXX/resources.json`
- `attempt-XXXX/snapshot-prejoin.txt`
- `attempt-XXXX/snapshot-final.txt`

Chaos suite output directory:

`tests/results/agent-browser-chaos/<timestamp>/`

Artifacts per scenario:
- `summary.json`
- `report.md`
- `<scenario>/snapshot.txt`
- `<scenario>/body.txt`
- `<scenario>/console.json`
- `<scenario>/errors.json`
- `<scenario>/final.png`

Per-attempt correlation fields in `results.ndjson`:
- `attempt`, `session` (agent-browser daemon session), `startedAt`, `finishedAt`
- `roomUrl`, `roomSlug`, `browserSessionId`
- `correlation.requestId` (`x-request-id`), `correlation.traceId` (`x-chalk-trace-id`), `correlation.cfRay`
- `correlation.apiRequestPath`, `correlation.apiStatusCode`, `correlation.roomId`

Correlate attempt -> backend trace:
1. From `correlation-map.ndjson`, copy `apiRequestId` and/or `apiTraceId` for the slow attempt.
2. Query API logs for `event=participant.join_room` and the same `request_id`/`trace_id`.
3. Use backend fields:
   - `join_total_ms`, `join_db_total_ms`, `join_cloudflare_total_ms`
   - `join_cloudflare_step_durations_ms`
   - `join_cloudflare_operations` (attempts/retries/timeouts/outcome)

## Notes

- Reuses one `agent-browser` daemon per worker by default (lower CPU/RAM churn).
- For heavy stress, increase `--concurrency` gradually to avoid local machine bottlenecks.
- Keep `--join-timeout-ms` high enough (e.g. `45000`) to capture slow but successful joins.
