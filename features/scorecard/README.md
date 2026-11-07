# Performance scorecard

Every iteration should show what improved and what regressed. A run writes one scorecard per media plane, and `scorecard diff` compares it with a baseline using the budgets in `perf/budgets.json`.

## Budgets

`perf/budgets.json` has three parts:

- `_comment`: the history of budget changes, one reason per change.
- `callRun`: the settings the web call performance check uses (devices, repeats, leak budgets).
- `budgets`: one entry per metric id, `{ max_p50?, max_p95?, tolerancePct, gate }`. An entry needs at least one limit.

`gate: true` means a result over the limit fails the check. `gate: false` only warns. A metric starts with `gate: false` when it comes from a real node, and flips to true in its own pull request once it has seven nightly values and its run-to-run spread is below its `tolerancePct`. Deterministic pull request metrics, such as bundle sizes, start with `gate: true`.

The web call check bounds the median of its repeated runs, so its entries use `max_p50`. `web.<device>.<scenario>.<metric>` is one scenario on one device, and `web.route.*` is the pre-join route bundle.

`budgets.mjs` converts between this file and the device and scenario view the check uses.
