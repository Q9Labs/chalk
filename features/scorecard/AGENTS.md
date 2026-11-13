# Scorecard

The Chalk performance scorecard records how a run of Chalk performed, as one `chalk.scorecard/v1` file per media plane per run, so runs on `chalk_sfu` and `cf_sfu` compare by matching metric ids. `schema.mjs` owns the shape, the metric registry and the validator. Every kit that writes a scorecard validates it with `parseScorecard` before it saves the file.

- Metric ids are stable and dotted. Renaming an id or changing its unit breaks history, so add a new id instead.
- Each id has one unit in `METRICS`, and a metric in a file must use that unit.
- Scorecard history is public. A file holds no host, IP, URL, Tenant, Space or other resource id, and a drop reason is a snake_case code, never free text.
- `perf/budgets.json` is the only budget file. Never add a second one or a limit that lives in a script. A budget changes only in a pull request that edits it and adds a reason line to its `_comment`.
- A budget entry is `{ max_p50?, max_p95?, min_p50?, tolerancePct, gate }`. Every entry gates (`gate: false` fails the checks register). A metric from a real node gates from the start with a loose ceiling and tightens in its own pull request once seven nightly values from at least three different nights have a run-to-run spread below its `tolerancePct`. Each of them is also required evidence: `evaluate.mjs` marks the nightly cut `missing` when no `chalk_sfu` card measures one, so gate a `chalk_sfu.action.*` metric only after the latency kit emits it every cycle.
