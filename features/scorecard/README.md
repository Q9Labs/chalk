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

## Scorecard files

`scorecard.mjs build` turns reports that other tools already write into one `chalk.scorecard/v1` file. Each flag names one input:

| Flag            | Input                                                                                    | Metrics                                                                                                        |
| --------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--web`         | the report of `apps/web/scripts/check-call-performance.mjs`                              | `web.*`                                                                                                        |
| `--sfu-tests`   | `go test -json` of `features/media/sfu` (the gate writes it when `SFU_TEST_JSON` is set) | `sfu.loopback.pass`, `sfu.impairment.pass`                                                                     |
| `--sfu-live`    | the file the live smoke test appends to through `SFU_LIVE_SAMPLES`                       | `sfu.loss_pct`, `sfu.stalls_per_class_hour`, `sfu.admission_refusals`                                          |
| `--sfu-load`    | a node load summary (shape below)                                                        | `sfu.cpu_work_pct_per_class`, `sfu.pps_*_per_class`, `sfu.egress_mbit_s_per_class`, `sfu.freeze_ms_per_minute` |
| `--proof-join`  | the result file of `scripts/web-proof/join-startup.mjs`                                  | `proof.join_startup.*`                                                                                         |
| `--proof-leave` | the Leave proof result                                                                   | `proof.leave_median_ms`                                                                                        |
| `--device`      | the device lane's file (shape below)                                                     | `device.*`                                                                                                     |
| `--action`      | a scorecard the latency kit wrote                                                        | `action.*`                                                                                                     |

The metric ids and their units are in `schema.mjs` (`METRICS`). A pass value is the share of runs that passed, from 0 to 1. Its budget uses `min_p50`, because higher is better.

`scorecard.mjs diff --current a.json --baseline b.json` prints the delta table. ❌ means over a budget, ⚠️ means more than the metric's `tolerancePct` worse than the baseline but within budget, and ✅ means more than 5% better. A ❌ on an entry with `gate: false` is a warning; with `--fail-on-gate`, a ❌ on a `gate: true` entry fails the command.

A scorecard uses `chalk_sfu` as its media plane when the metrics do not depend on one, such as bundle sizes.

### Node load summary

The SFU node reports its steal and packet rate, but not its CPU busy time, per-direction packet rates, or egress. The load harness writes these as one JSON file:

```json
{ "samples": [{ "classes": 3, "cpuBusyPercent": 42, "stealPercent": 6, "ppsIn": 3000, "ppsOut": 9000, "egressMbitPerSecond": 30, "freezeMsPerMinute": 120 }] }
```

A class is one call of three Participants. Each sample is one reading; the adapter divides by `classes` and reports p50 and p95 over the samples.

### Device file

The device lane writes one file per run, with one entry per scenario and one run per attempt:

```json
{
  "scenarios": [
    {
      "name": "network_switch",
      "runs": [
        { "passed": true, "ms": 820 },
        { "passed": false, "ms": null }
      ]
    }
  ]
}
```

`name` is `network_switch` (reconnect after a network switch, id `device.reconnect_ms`), `background_resume` (time to media after 30 to 60 s in the background, id `device.background_resume_ms`) or `ice_restart` (id `device.ice_restart_ms`). `ms` is the time of a passing run and is `null` for a failed one. Every scenario also gives `device.<name>.pass`. The run's tier is `manual`, its `client.kind` is `sdk`, and the platform goes in `--browser`, for example `ios/26.1`.

## The pull request tier

`pr-tier.sh` runs inside the existing Gate jobs and adds no job of its own. The `build` group scores the call bundle sizes and the `checks` group scores the SFU loopback and impairment tests, the latter only when the SFU gate lane ran. Each compares with the scorecard of the latest landed master change, which is the latest successful merge queue Gate run that has one (the `scorecard-web` and `scorecard-sfu` artifacts; master pushes run no Gate), writes the table to the run summary and updates its section of one sticky pull request comment.
