# Lane Z — reconnecting notice on short drops

## Failed or unproven

- **One B cut attempt was ineligible.** On attempt 10, initial remote audio/video did not flow within 25 s, and four-way media later failed to return within 20 s. A had 10/10 eligible attempts; B needed 11 attempts for 10 eligible results. The cause of this B-only setup failure is unproven. It is recorded in the sanitized JSONL, excluded from recovery statistics, and **not** counted as timing noise.
- **Literal loss-detection-to-notice latency is unmeasured.** The five-second cut left the browser WebSocket open, so Lane T's unchanged close-based `transportLossDetectedMs` field is null. B displayed reconnecting in all 10 eligible cuts within 368–797 ms of fault onset, a conservative sub-second onset bound, but the requested detected-loss delta cannot be directly computed from this harness.
- **The comparison baseline is frozen, not today's moving master.** A is `3a77a9fbb8d545f876d75f6a25e5d1021e45924c`, which was `origin/master` when this A/B was pinned. Master advanced to `a111707b` during the long run, mainly in media/API code and without touching Lane Z's SDK paths. The PR checks against current master passed, but a new same-M4 A/B against the later master was not run.
- The automated code-review CLI could not initialize (`Operation not permitted`) on its one attempted run before full filesystem access was restored. There is no independent automated review result from that tool.

## Result

**The eligible comparison passes.** The final tip is `a5448d5fa3313b98efd5b91ffe72ffa7777c3c27`. A and B ran interleaved on the same `agents-macmini` M4 with separate browser and database roots, using Lane T's `stress.mjs` and `network.sh` with only Lane Z names and port base **44000** substituted. The exact harness measured 10 eligible five-second cuts and 10 eligible 180-second flapping runs per arm, plus 5 eligible Sync restarts per arm. Missing measurements were censored, never zero-filled.

P95 seconds; state is Lane T's state-plus-outcome `convergenceMs`; media is the slowest of audio and video in both directions.

| Scenario | Arm | Eligible/attempts | Sync | State + outcomes | Four-way media | Action terminal |
|---|---|---:|---:|---:|---:|---:|
| 5 s cut | A | 10/10 | 0.111 | 0.366 | 1.158 | 5.256 |
| 5 s cut | B | 10/11 | 0.132 | 0.382 | 1.374 | 5.214 |
| 180 s flapping | A | 10/10 | 3.870 | 3.868 | 2.383 | 3.217 |
| 180 s flapping | B | 10/10 | 3.849 | 3.847 | 2.863 | 3.258 |
| Sync restart | A | 5/5 | 0.077 | 0.075 | 0.216 | 1.011 |
| Sync restart | B | 5/5 | 0.072 | 0.068 | 0.256 | 1.002 |

Before measuring, I set timing-noise bounds of **0.5 s** for Sync, state, and actions and **1.0 s** for worst four-way media, applied to both p95 and max. The largest B-minus-A flapping media difference was 0.480 s; all 12 metric/scenario p95 and max comparisons are within their bounds. No new eligible failure, censored outcome, pending/lost/duplicated action, or chat/hand outcome difference counts as noise. All eligible Participant views converged. Chat and hand resolved in all cut and flapping runs; on Sync restart both arms had the same five `chat.payload_invalid` rejections while all hands resolved.

Master showed no reconnecting notice in 0/10 eligible cuts; B showed it in 10/10, median 514 ms and maximum 797 ms from fault onset. [The side-by-side sheet](screenshots/side-by-side.png) shows the same-M4 cut before and after. [The comparison](comparison-m4.md), [aggregates](analysis-m4.json), [sanitized per-trial records](results-m4/), and [interleaved attempt log](matrix-m4.txt) provide the complete counts and distributions.

## Change and checks

- The live Sync client sends a **presentation-only** ping every 500 ms and marks the optional notice bit after 750 ms without an inbound frame. An inbound frame clears it. The existing 20 s recovery heartbeat, socket lifecycle, retry timing, command budgets, action outcome rules, chat handling, and media reconciliation are unchanged.
- The lifecycle publishes only this notice bit immediately even when an offline action occupies its serial queue. The Space store maps **live + unresponsive** to the existing reconnecting UI state; ordinary Sync `connecting` does not trigger that overlay. No service recovery policy was changed.
- Notice, blocked-action, cadence, and narrowed-store tests each failed against the preceding implementation and passed after their corresponding change. The selected M4 tip passed `pnpm run gate`: **15 passed, 0 failed, 6 skipped in 163.352 s**. The PR's browser, CodeQL, analyzer, mobile type, unsigned Android, and unsigned iOS checks passed before this report-only commit.

The earlier broad notice candidate was rejected because Sync-restart action p95 rose from 1.028 s on master to 2.053 s on B. A separate API-health-probe experiment also showed early flapping action delay and was removed. The selected implementation keeps only the smaller Sync notice probe and narrowed UI mapping. It does not reproduce Lane T's rejected media delay or new offline-chat rejection in eligible cuts: B cut media p95 is 1.374 s versus A's 1.158 s, and all 10 eligible chat actions resolve in each arm.

## Delivery and cleanup

Non-draft [PR #121](https://github.com/Q9Labs/chalk/pull/121) targets master and ends with the requested Codex/Claude Code line. No deploy, release, or merge occurred. The M4 Lane Z stack stopped; all six stopped containers, four volumes, the unique browser image, both uniquely named `/tmp` trees, and port-44000 listeners were verified removed. Worktree-local temporary launchers, raw screenshots, diagnostic trees, and the no-longer-needed `node_modules` were removed. Only sanitized public evidence and this report remain in the PR.
