# Retry harness fixes and cheap proofs

One judge round only; no second judge was requested or run. These proofs exercise safety behaviour, not a successful capacity run.

| Earlier finding | Fix | Proof |
|---|---|---|
| Owner-loss protection absent | Runner starts independent guardian; persisted budget deadline triggers stop/cleanup | Linux tests kill owner and exercise real watchdog deadline branch |
| SSH failure skips deletion | All cleanup actions attempted independently; deletion does not wait for shared-host mutation permission; cleanup errors are nonzero and do not mark completion | Integration extracts actual runner finally and remove_worker, injects SSH/revoke failures; policy test checks every action |
| Create timeout orphans worker | Persist tagged creation intent and billable ledger entry before call; reconcile in finally and cleanup | Actual provision integration injects TimeoutExpired; policy reconciles discovered provider ID and preserves charge |
| Queued flag mutation | Nonblocking deployment lock, pre/under-lock/last-moment expiry, controller and readiness check, cancel SSM on timeout/signal | Linux busy-lock test exits75 without marker; expired command exits76 without marker |
| Stop ignored during setup | Generator checks stop/deadline before admission/Recording start, in readiness, and after guard response; launcher does not clear a stop after failure | Exact generator guard function injected stop at entry and while waiting; both reject before mutation |
| Missing charges/deadlines | Charge from intent timestamp, retained through deletion; reserve20min finalization and$0.06 cleanup; budget-derived finish enforced by guardian and worker RuntimeMaxSec | Deadline math test; unknown-intent/minimum-charge tests; actual guardian deadline test |
| Incomplete bundle proof | Require contiguous v2 sequence and measured interval span; report gap/hole metadata separately, never call gap-bearing output gap-free | Missing-sequence/short-span policy test |

Results: Linux9/9 passed (no skip), injected integration3/3 passed, generator stop2/2 passed. No paid harness ran. No claimed live proof for owner-loss cloud cleanup or completed Render: these are injected tests only. Budget rate reserve uses Capture$0.02679/h plus Render$0.25/h; the actual ledger remains$0 because neither was allocated.
