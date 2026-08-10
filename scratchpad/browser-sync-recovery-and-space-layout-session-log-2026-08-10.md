# Browser Sync recovery and Space layout session log

## 2026-08-10

- Reproduced the production browser failure from the supplied recording and a live Chrome journey.
- Proved that the Sync WebSocket completed its handshake and recovery before the client closed the healthy socket and retried.
- Traced the loop to stale queued Sync snapshots in the Connection lifecycle.
- Confirmed that the production Space route disabled the Entrance and did not give `<Chalk />` a definite viewport-height parent.
- Added focused recovery coalescing, Entrance, and viewport layout changes with regression coverage.
- Corrected the React test runner's diagnostics-contracts source alias after the clean M4 gate exposed the wrong package scope.
- Focused client and web tests, type checks, formatting, diff checks, and the full staged M4 smart gate passed.
- The local commit hook later failed on three unrelated shared-worktree web tests (two timeouts and one duplicate diagnostics route); the clean staged M4 gate remained green. Filed complaint #4000.
