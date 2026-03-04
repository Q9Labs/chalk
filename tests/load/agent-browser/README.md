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

## Outputs

Each run writes to:

`tests/results/agent-browser-join/<timestamp>/`

Main artifacts:
- `summary.json`
- `report.md`
- `results.ndjson`
- `attempt-XXXX/console.json`
- `attempt-XXXX/errors.json`
- `attempt-XXXX/resources.json`
- `attempt-XXXX/snapshot-prejoin.txt`
- `attempt-XXXX/snapshot-final.txt`

## Notes

- Reuses one `agent-browser` daemon per worker by default (lower CPU/RAM churn).
- For heavy stress, increase `--concurrency` gradually to avoid local machine bottlenecks.
- Keep `--join-timeout-ms` high enough (e.g. `45000`) to capture slow but successful joins.
