# Chalk MCP evaluation

Verdict: inconclusive (a proof run is not a model-selection benchmark).

| Metric                                            | tools                             | code                              |
| ------------------------------------------------- | --------------------------------- | --------------------------------- |
| All tasks                                         | 57/72 (79.2%; 95% CI 68.4%–86.9%) | 58/72 (80.6%; 95% CI 70.0%–88.0%) |
| Operational tasks (excludes text capability gaps) | 57/60                             | 58/60                             |
| Uncached input tokens                             | 88027                             | 88437                             |
| Output tokens                                     | 29311                             | 74300                             |
| Cache read tokens                                 | 3035958                           | 2171024                           |
| Cache creation tokens                             | 242599                            | 473484                            |
| Assistant turns                                   | 332                               | 583                               |
| Client tool calls                                 | 260                               | 511                               |
| Client tool errors                                | 9                                 | 0                                 |
| Server shared-operation calls                     | 260                               | 325                               |
| Server shared-operation errors                    | 9                                 | 83                                |
| Server code tool calls                            | 0                                 | 511                               |
| Server code tool errors                           | 0                                 | 0                                 |
| Cost (CLI list-price accounting, USD)             | $1.5359                           | $2.8189                           |
| Trials with incomplete cost accounting            | 0                                 | 0                                 |
| Sum of trial wall times (seconds)                 | 876.5                             | 1557.6                            |
| Run elapsed (seconds, including fixtures)         | 1857.7                            | 2181.5                            |
| Median trial (seconds)                            | 10.7                              | 21.6                              |
| Model / effort                                    | claude-sonnet-5-5 / medium        | claude-sonnet-5-5 / medium        |
| k / concurrency                                   | 3 / 2                             | 3 / 2                             |
| API source                                        | `d23b75a827af`                    | `d23b75a827af`                    |

## Tasks

★ marks different pass counts between arms; † marks a transcript text capability gap.

| Task                   | tools                                             | code                                              |
| ---------------------- | ------------------------------------------------- | ------------------------------------------------- |
| connection             | 3/3                                               | 3/3                                               |
| active-spaces          | 3/3                                               | 3/3                                               |
| archived-spaces        | 3/3                                               | 3/3                                               |
| space-settings         | 3/3                                               | 3/3                                               |
| episode-counts         | 3/3                                               | 3/3                                               |
| attendance ★           | 3/3                                               | 2/3 — unsupported_capability                      |
| frequent-attendees ★   | 2/3 — invalid_answer_json                         | 3/3                                               |
| live-spaces            | 3/3                                               | 3/3                                               |
| admissions             | 3/3                                               | 3/3                                               |
| exports                | 3/3                                               | 3/3                                               |
| transcript-languages ★ | 1/3 — invalid_answer_json                         | 3/3                                               |
| memberships            | 3/3                                               | 3/3                                               |
| webhook-history ★      | 3/3                                               | 2/3 — invalid_answer_json                         |
| archive-space          | 3/3                                               | 3/3                                               |
| recording-settings     | 3/3                                               | 3/3                                               |
| rotate-key             | 3/3                                               | 3/3                                               |
| create-test-webhook    | 3/3                                               | 3/3                                               |
| change-membership      | 3/3                                               | 3/3                                               |
| missing-scope          | 3/3                                               | 3/3                                               |
| restore-space          | 3/3                                               | 3/3                                               |
| invoice-search †       | 0/3 — invalid_answer_json, unsupported_capability | 0/3 — invalid_answer_json, no_server_evidence     |
| urdu-reading †         | 0/3 — invalid_answer_json, unsupported_capability | 0/3 — invalid_answer_json, unsupported_capability |
| arabic-reading †       | 0/3 — invalid_answer_json, unsupported_capability | 0/3 — invalid_answer_json, unsupported_capability |
| long-transcript †      | 0/3 — unsupported_capability                      | 0/3 — invalid_answer_json, unsupported_capability |

## Interpretation

- Every trial must have a successful fresh Claude session and API-side completed calls. Missing server evidence fails the trial even if the answer matches.
- Passes require exact JSON facts and, for writes, the resulting DB state. Prompts require read-back, but graders do not infer verification from code text. No LLM graders are used.
- The base /mcp catalog has no transcript text-read/search tools. Four text tasks remain failures, also reported separately from the 20 operational tasks. Their synthetic corpus is stored in a fixture-only table, not a production object-store emulator.
- Wilson 95% intervals treat trials as independent. Repeated tasks are correlated; these intervals are descriptive and understate task-selection uncertainty. k=1 is only a harness proof.
- CLI accounting includes auxiliary-model overhead (if any), caching, startup and MCP discovery; wall time includes retries. Server counts include rejected calls. Expected scope rejection is not itself a failed task.
- A webhook test proves enqueueing, not external delivery. No live media/provider, production service or real customer data participates.
- Do not choose an arm until both complete on the same revision, fixture, settings and task set; alternate arms across repeated runs to reduce cache/load/order bias.

## Full-run estimate

Both arms at k=3: approximately $4.35 and 67.3 minutes at the same concurrency. Scaling the measured arms linearly; caching and model variance can change this. This is an extrapolation, not a measured k=3 result.
