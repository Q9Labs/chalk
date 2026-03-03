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
- `--concurrency 10`
- `--base-url https://chalk.q9labs.ai`

Example:

```bash
bash tests/scripts/run-agent-browser-join-stress.sh --count 100 --concurrency 20
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

- Uses separate `agent-browser` session per attempt.
- For heavy stress, increase `--concurrency` gradually to avoid local machine bottlenecks.
- Keep `--join-timeout-ms` high enough (e.g. `45000`) to capture slow but successful joins.
