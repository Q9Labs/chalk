# Operations async review fixes session log

- 2026-07-12 04:43 PKT — Moved Readiness probes and Retention Scheduler cleanup into monitored, non-linked workers. Synchronous `probe_now`/`run_now` callers wait for the current worker while health calls remain handled by the GenServer. Added no-overlap guards, stale result/monitor-message ignores, and shutdown termination for in-flight workers.
- 2026-07-12 04:43 PKT — Added deterministic blocked-work responsiveness tests for readiness and retention plus readiness shutdown worker cleanup coverage. Focused tests: 6 passed. Targeted format check and Credo: passed with no issues.
