# Benchmark Comparison

- Current run: 2026-03-05T02-37-05Z-full-trace-safe-live-595d86b
- Baseline A: 2026-03-04T20-36-15-181Z
- Baseline B: 2026-03-05T01-41-00Z-full-trace-bg-live

| Metric | Current | Baseline A | Delta vs A | Baseline B | Delta vs B |
|---|---:|---:|---:|---:|---:|
| Attempts | 100 | 100 | 0 | 100 | 0 |
| Success | 98 | 99 | -1 | 96 | +2 |
| Failed | 2 | 1 | +1 | 4 | -2 |
| Success rate % | 98 | 99 | -1 | 96 | +2 |
| Join min ms | 6126 | 6114 | +12 | 7290 | -1164 |
| Join p50 ms | 6164 | 8439 | -2275 | 9622 | -3458 |
| Join p95 ms | 10812 | 13223 | -2411 | 16612 | -5800 |
| Join p99 ms | 13156 | 15473 | -2317 | 19026 | -5870 |
| Join max ms | 14368 | 17750 | -3382 | 21278 | -6910 |
| Join avg ms | 7139 | 8559 | -1420 | 10364 | -3225 |

## Failure Reasons
- Current: ask_to_join_button_missing (2)
- Baseline A: ask_to_join_button_missing (1)
- Baseline B: ask_to_join_button_missing (3), join_timeout (1)
