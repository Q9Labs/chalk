# Performance scorecard

Every iteration should show what improved and what regressed. A run writes one scorecard per media plane, and `scorecard diff` compares it with a baseline using the budgets in `perf/budgets.json`.

## Budgets

`perf/budgets.json` has three parts:

- `_comment`: the history of budget changes, one reason per change.
- `callRun`: the settings the web call performance check uses (devices, repeats, leak budgets).
- `budgets`: one entry per metric id, `{ max_p50?, max_p95?, tolerancePct, gate }`. An entry needs at least one limit.

`gate: true` means a result over the limit fails the check. `gate: false` only warns. A metric starts with `gate: false` when it comes from a real node, and flips to true in its own pull request once seven nightly values from at least three different nights have a run-to-run spread below its `tolerancePct`. Deterministic pull request metrics, such as bundle sizes, start with `gate: true`. The `chalk_sfu.action.*` entries are the exception: they gate with a loose ceiling of twice the worst p95 in the earliest evidence, and the same rule later tightens them. [The budget doc](../../docs/performance-budget.md#changing-a-budget) has the details.

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

`pr-tier.sh` runs inside the existing Gate jobs and adds no job of its own. The `build` group scores the call bundle sizes and the `checks` group scores the SFU loopback and impairment tests, the latter only when the SFU gate lane ran. Each compares with the scorecard of the latest successful master push run (the `scorecard-web` and `scorecard-sfu` artifacts), writes the table to the run summary and updates its section of one sticky pull request comment.

## The nightly tier

`nightly.sh` runs at the end of the `Cut nightly` workflow, in its own `scorecard` job, which runs even when the cut fails or is held. It compares the Leave proof scorecard of the run with the median of the last seven nightly runs, appends it to `history.jsonl` on the `scorecard-history` branch, regenerates the trends file (the last 14 nightly values of every metric) and keeps one open `Scorecard regression` issue while a gated metric is over its budget. The nightly run measures staging only and never the production node.

The `own-sfu` job of the same workflow runs after `release`, when the cut deployed. It calls the real-call proof workflow with `media_plane: chalk_sfu` and `latency: true`: the `camera-share` proof, then `pnpm prod:latency --planes chalk_sfu` (20 cycles) against the nightly API for the cut's revision, in headless Chromium on the GitHub-hosted runner. The latency kit writes the `chalk_sfu` scorecard, `own-sfu.mjs` lists every metric against its budget in the job summary, and the card goes up as the `scorecard-nightly-chalk_sfu` artifact for the `scorecard` job to compare and append like any other card. The job fails when the proof or the latency run fails, when a gated `chalk_sfu.action.*` p95 is over its ceiling, or when the card is missing or has no metrics. A failure turns the job red and leaves the deploy and the release record alone. The artifact lives 3 days, which is enough: the seven-values-over-three-nights window reads `history.jsonl` on the `scorecard-history` branch, not the artifacts. The latency kit cleans up its own Spaces and Episodes, and the proof's cleanup step removes them again when the run is cut short.

The `cf-sfu-latency` job runs the same latency kit on `cf_sfu` from the same GitHub-hosted runner, so Cloudflare's `action.*` metrics have current nightly values. It calls the real-call proof workflow with `media_plane: cf_sfu`, `latency: true` and `latency_only: true`, takes the kit's default 20 cycles (the `chalk_sfu` run takes 60), and uses that workflow's 50-minute job and 25-minute step timeouts for every plane other than the nightly `chalk_sfu` run. It waits for `own-sfu` so its API traffic is outside that job's contention window, and it holds no staging lease because Cloudflare media never touches the staging SFU node. `record` does not need it, so a slow or failed run never holds the cut; the `scorecard` job waits for it so its card reaches the history. Every sample and every card names its plane (`mediaPlane` on the card, and `plane` on each cycle in the kit's private evidence). The `cf_sfu` budgets are all `gate: false`, so its card warns and cannot change a verdict (`features/scorecard/cf-sfu-card.test.mjs` runs `evaluate.mjs` with and without it). Every place that shows the card also shows the note from `features/scorecard/plane-note.mjs`: from Iowa, Cloudflare media goes to a nearby point of presence and ours goes to Singapore, so the two planes are not a fair comparison yet.

Before recording the cut, `evaluate.mjs` reads `perf/budgets.json` from the scored SHA using `git show` and saves a SHA-and-run-bound `passed`, `gated-breach` or `missing` verdict with the budget revision, gated metric names and missing evidence. Every deployed nightly cut runs the own-SFU proof, so a Cloudflare card alone cannot replace a missing own-SFU card. The own-SFU cards together must also measure every `chalk_sfu.action.*` metric with `gate: true` in those budgets, with at least one sample; the latency kit records all of them every cycle, so one that is absent or has no samples is named in the missing evidence (`chalk_sfu.action.leave_ms`) instead of passing. Missing, empty, wrong-revision or contended cards cannot produce a passing verdict. The history job retains its regression issue behavior and exits nonzero on a gated breach. Nightly records the own-SFU proof and scorecard verdict separately; Promote checks both at selection and approval recheck, honoring the existing `scorecard_override` reason for failed proof, gated breaches or named missing evidence. Warn-only budgets remain warnings.

### Latency diagnostics

The latency kit also records where an action's time goes. These numbers live in a sidecar file, `latency-diagnostics-<plane>.json`, next to the scorecard and in the same artifact, and never in the card: readers that shipped before this change reject a card with a field they do not know, so the card keeps the shape they know. The gate, the diff, the history and the baseline never open the sidecar. Only the run summary of `own-sfu.mjs` reads it, and it never throws: a missing or invalid sidecar becomes one line of text (`features/scorecard/diagnostics.test.mjs` runs `evaluate.mjs`, `diff --fail-on-gate`, `append`, `baseline` and `own-sfu.mjs` with good and hostile sidecars beside the card and expects the same verdicts and exit codes). `perf/budgets.json` has no entry for them.

- `rtt.sfu_ms` is the selected ICE candidate pair's `currentRoundTripTime` on the acting guest's peer connections (the lowest if there are several); a pair with no current reading stays missing. `rtt.sync_ms` is the median round trip of the SDK's own Sync `ping` and the `pong` that answers it, read from the trace after the cycle: the kit sends nothing on the Sync socket, so it cannot touch the SDK's liveness checks. A cycle in which no SDK ping was answered has none. Both come from the runner (a GitHub-hosted runner in Iowa for the nightly), so they show the distance to the plane under test.
- `stages` splits each action (`mic_on`, `mic_off`, `camera_on`, `camera_off`, `screen_start`, `screen_stop`, `join`) into the pieces between wire events: the Sync command leaving, the roster frame reaching the receiver, the receiver's `listPublications`, pull (`tracks`), `tracks/close` and `renegotiate` replies, then the first new frame or packet. `features/scorecard/stages.mjs` names every stage and says what it covers; the card prints those descriptions. A stage counts from the last stage reached, so a step the SDK skips is null and its time moves to the next one. `sync_ack`, `sfu_publish`, `sfu_close` and the join SFU steps run beside the chain and count from the call.
- Both guests run on one host, so every reading is `performance.timeOrigin + performance.now()` and the two pages share a clock to within the browser's resolution (about 0.1 ms). A reading before the previous one counts as zero.
- `scripts/prod-proof/latency-trace.mjs` records the events from inside the page as an init script that only the latency kit installs, the way `scripts/prod-proof/leave-observation.mjs` observes Leave. The product SDK carries no trace code, and the trace changes no frame or request. A failed trace read leaves that action's stage fields null and the cycle still counts.

### Staging contention

Shared staging measurements run under the Git-ref lease described in the
[SFU lane protocol](../media/sfu/README.md#shared-staging-node). Only nightly's
own-SFU caller grants `contents:write`; other reusable proof callers retain
their existing permissions. A direct staging dispatch without write access
fails closed at lease acquisition. The first lease attempt is immediate, then
retries once with a bounded 10-minute wait.

Cleanup by run ID always runs without taking the lease, even when another lane
holds it. The cleanup only ends that proof's Episodes and archives its Spaces;
any deletion failure fails the job. A busy lease must never strand resources.

The measurement reads API-log windows before and after the latency kit and
queries its complete measurement window after a 30-second ingestion allowance.
`staging-logs.mjs` owns dataset configuration in one place:
`CHALK_AXIOM_STAGING_LOG_DATASET` is the nightly environment variable, and
`CHALK_AXIOM_QUERY_TOKEN` is the existing read-only query credential, scoped to
that dataset. The collector selects `chalk_sfu` provider events, counts distinct
foreign Episode and provider-session IDs, and excludes its own Episodes by
`episode_id`. The latency kit writes those IDs only into private, encrypted
evidence. Public cards contain counts, never Episode or connection IDs or
dataset names. Lease labels and times are public: use non-sensitive labels.

The optional `contention` block records each signal as `{ value, source }`;
unavailable signals have `value: "unavailable"`, never an invented zero.
`lease_holder_before` and its acquisition/expiry times come from the Git ref.
`foreign_episodes_seen`, `foreign_sessions_seen`, before/after event counts,
measurement event count and own-Episode event count come from API logs.
Node gauges use a second, read-only Axiom MPL source. Configure nightly's
`CHALK_AXIOM_STAGING_METRICS_DATASET` and `CHALK_AXIOM_METRICS_BASE_URL` variables
for the metrics dataset's edge deployment. The existing
`CHALK_AXIOM_METRICS_QUERY_TOKEN` repository secret is exposed only to the
own-SFU latency step, and is removed from the latency kit's environment.
Dataset configuration lives in `staging-logs.mjs` for both collectors.

`staging-metrics.mjs` filters `service.name=chalk-sfu` and
`deployment.environment.name=staging`. It queries maximum gauge values per
incarnation before, during and after measurement. `chalk.sfu.host.cpu.steal`
is a ratio and becomes `steal_max` in percent. Distinct `service.instance.id`
tags supply incarnation changes; `chalk.sfu.draining` supplies drain state.
Only boundary `chalk.sfu.sessions` readings count as foreign sessions, because
in-window sessions include the kit's own. Incarnation IDs never enter a card.
Before starting the kit, the collector refreshes sessions over the latest
30-second window after the three historical gauge queries finish. A positive,
empty or failed refresh prevents the workload from starting.

Missing tokens, failed queries, empty readings and incomplete responses leave
node signals **unavailable**, never zero. Node coverage in all three phases is
required; unavailable steal cannot produce an isolated card.
API observation spans the preflight boundary through workload completion, so
joins while the metrics queries run are not lost. Failures retain fixed,
redacted reason codes in the job log and step summary, never raw exceptions.
The observed metrics-v2 response has no pagination or completeness field. The collector
rejects unexpected response metadata and results reaching its conservative
1,000-point or 1,000-series cap; that cap is a collector policy, not a claimed
MPL endpoint limit. Queries use `align using max`, so normal responses hold one
peak per incarnation. A sanitized live wire shape is retained in
`fixtures/axiom-metrics-shape.json` for the fake-response tests.

A successful API query with no `chalk_sfu` events sets
`zero_chalk_sfu_events.value: true`: it may mean an idle node or a logging gap,
not measured zero load. Missing/partial log windows (including a full 1,000-row
page, a continuation token, or more matching rows than returned), no own-Episode coverage,
a lost lease, or observed foreign Episodes make a card `contended: true`.
Quiet API logs do not prove that an already connected, silent foreign session
is absent; boundary session gauges provide an additional check.

After a contended attempt, the job waits up to 10 minutes for a quiet API-log
window and retries the measurement once under the lease. Each measurement is
bounded to 20 minutes. It never adds load while its pre-measurement log window
is busy or unreadable. Both attempts remain in encrypted evidence; only the
selected final card is published. A contended final card (including an empty
one on lease timeout) is prominently labelled in summaries and scorecard
comments, fails the measurement job, and remains in history for diagnosis.
It is excluded from baselines and trends, does not open a performance-regression
issue, and cannot close an existing issue as though it were a clean result.
Budgets are unchanged; an uncontended gated breach still fails the latency kit.

## The Promote tier

After the production proof passes, the Promote workflow scores the Leave run of that Promote against the nightly median. These jobs run only after `proof`, and no other job needs them or reads their result, so a failure cannot start `rollback`; it only turns the Promote run red.

1. `scorecard` scores the first proof. A gated metric over its budget starts one rerun of the Leave proof.
2. `scorecard-rerun` runs the Leave proof once more.
3. `scorecard-final` fails the run only when a gated metric is still over its budget in the rerun, and opens or updates the `Scorecard regression` issue. An issue left open from an earlier run never blocks.

The `scorecard_override` input of the Promote workflow takes a written reason. Empty or whitespace-only reasons do not override a check; there are no other length, format or user-role rules beyond normal dispatch permissions and production approval. The same input accepts failed, skipped or missing nightly own-SFU proof, gated nightly scorecard breaches and missing scorecard evidence, recording the accepted results, metrics, missing items, reason and actor in the run summary and retained production release record. SHA mismatches and invalid release artifacts still block. For the production proof, the gate still shows the table and records the reason in the run summary and as a comment on the open regression issue. Per-budget `gate: false` remains warn-only.
