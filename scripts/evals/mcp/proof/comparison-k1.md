# Chalk MCP evaluation

Verdict: inconclusive (a proof run is not a model-selection benchmark).

| Metric                                            | tools                             | code                              |
| ------------------------------------------------- | --------------------------------- | --------------------------------- |
| All tasks                                         | 20/24 (83.3%; 95% CI 64.1%–93.3%) | 19/24 (79.2%; 95% CI 59.5%–90.8%) |
| Operational tasks (excludes text capability gaps) | 20/20                             | 19/20                             |
| Uncached input tokens                             | 29341                             | 29463                             |
| Output tokens                                     | 9113                              | 24084                             |
| Cache read tokens                                 | 980112                            | 616277                            |
| Cache creation tokens                             | 71067                             | 150518                            |
| Assistant turns                                   | 110                               | 187                               |
| Client tool calls                                 | 86                                | 163                               |
| Client tool errors                                | 2                                 | 0                                 |
| Server shared-operation calls                     | 86                                | 102                               |
| Server shared-operation errors                    | 2                                 | 21                                |
| Server code tool calls                            | 0                                 | 163                               |
| Server code tool errors                           | 0                                 | 0                                 |
| Cost (CLI list-price accounting, USD)             | $0.4658                           | $0.8971                           |
| Trials with incomplete cost accounting            | 0                                 | 0                                 |
| Sum of trial wall times (seconds)                 | 294.7                             | 524.3                             |
| Run elapsed (seconds, including fixtures)         | 597.5                             | 724.8                             |
| Median trial (seconds)                            | 9.5                               | 20.6                              |
| Model / effort                                    | claude-sonnet-5-5 / medium        | claude-sonnet-5-5 / medium        |
| k / concurrency                                   | 1 / 2                             | 1 / 2                             |
| API source                                        | `529a9e7e9db6`                    | `529a9e7e9db6`                    |

## Tasks

★ marks different pass counts between arms; † marks a transcript text capability gap.

| Task                 | tools                        | code                         |
| -------------------- | ---------------------------- | ---------------------------- |
| connection           | 1/1                          | 1/1                          |
| active-spaces        | 1/1                          | 1/1                          |
| archived-spaces      | 1/1                          | 1/1                          |
| space-settings       | 1/1                          | 1/1                          |
| episode-counts       | 1/1                          | 1/1                          |
| attendance ★         | 1/1                          | 0/1 — unsupported_capability |
| frequent-attendees   | 1/1                          | 1/1                          |
| live-spaces          | 1/1                          | 1/1                          |
| admissions           | 1/1                          | 1/1                          |
| exports              | 1/1                          | 1/1                          |
| transcript-languages | 1/1                          | 1/1                          |
| memberships          | 1/1                          | 1/1                          |
| webhook-history      | 1/1                          | 1/1                          |
| archive-space        | 1/1                          | 1/1                          |
| recording-settings   | 1/1                          | 1/1                          |
| rotate-key           | 1/1                          | 1/1                          |
| create-test-webhook  | 1/1                          | 1/1                          |
| change-membership    | 1/1                          | 1/1                          |
| missing-scope        | 1/1                          | 1/1                          |
| restore-space        | 1/1                          | 1/1                          |
| invoice-search †     | 0/1 — unsupported_capability | 0/1 — unsupported_capability |
| urdu-reading †       | 0/1 — unsupported_capability | 0/1 — invalid_answer_json    |
| arabic-reading †     | 0/1 — unsupported_capability | 0/1 — unsupported_capability |
| long-transcript †    | 0/1 — unsupported_capability | 0/1 — unsupported_capability |

## Interpretation

- Every trial must have a successful fresh Claude session and API-side completed calls. Missing server evidence fails the trial even if the answer matches.
- Passes require exact JSON facts and, for writes, the resulting DB state. Prompts require read-back, but graders do not infer verification from code text. No LLM graders are used.
- The base /mcp catalog has no transcript text-read/search tools. Four text tasks remain failures, also reported separately from the 20 operational tasks. Their synthetic corpus is stored in a fixture-only table, not a production object-store emulator.
- Wilson 95% intervals treat trials as independent. Repeated tasks are correlated; these intervals are descriptive and understate task-selection uncertainty. k=1 is only a harness proof.
- CLI accounting includes auxiliary-model overhead (if any), caching, startup and MCP discovery; wall time includes retries. Server counts include rejected calls. Expected scope rejection is not itself a failed task.
- A webhook test proves enqueueing, not external delivery. No live media/provider, production service or real customer data participates.
- Do not choose an arm until both complete on the same revision, fixture, settings and task set; alternate arms across repeated runs to reduce cache/load/order bias.

## Full-run estimate

Both arms at k=3: approximately $4.09 and 66.1 minutes at the same concurrency. Scaling the measured arms linearly; caching and model variance can change this. This is an extrapolation, not a measured k=3 result.
