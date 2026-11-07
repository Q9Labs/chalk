# Scorecard

The Chalk performance scorecard records how a run of Chalk performed, as one `chalk.scorecard/v1` file per media plane per run, so runs on `chalk_sfu` and `cf_sfu` compare by matching metric ids. `schema.mjs` owns the shape, the metric registry and the validator. Every kit that writes a scorecard validates it with `parseScorecard` before it saves the file.

- Metric ids are stable and dotted. Renaming an id or changing its unit breaks history, so add a new id instead.
- Each id has one unit in `METRICS`, and a metric in a file must use that unit.
- Scorecard history is public. A file holds no host, IP, URL, Tenant, Space or other resource id, and a drop reason is a snake_case code, never free text.
