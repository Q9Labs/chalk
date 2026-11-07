# Scorecard

The performance scorecard: one `chalk.scorecard/v1` JSON file per run per media plane, compared against `perf/budgets.json` and the last baseline. Read [README.md](README.md) for the shape and the budget rules.

- `perf/budgets.json` is the only budget file. Never add a second one or a limit that lives in a script.
- A budget changes only in a pull request that edits `perf/budgets.json` and adds a reason line to its `_comment`.
- History is public. A scorecard holds no host, IP, Tenant, Space or other resource id.
- Add a metric by adding a new id. Never rename one, because history is keyed by id.
