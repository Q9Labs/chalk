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
- Deployed commit `31be5ef5` to the production Pages project after exact-SHA CI, CodeQL, packed-consumer, clean production build, and artifact checksum gates passed.
- Live Chrome showed the restored Entrance and full-viewport layout, then exposed one older synthetic Episode left active when its creator page unloaded; later attempts were correctly rejected by the one-live-Episode guard before reaching Sync.
- Added unload-safe, back-forward-cache-aware creator cleanup so leaving the page cannot strand the Episode; focused web tests pass.
- A clean post-cleanup Chrome journey reached the live Space without Sync recovery. Its wide-screen screenshot exposed the remaining SDK caps and single-Participant aspect constraint, so the SDK Space chrome/stage now use the full host viewport and the single tile fills the stage; focused React and web tests and type checks pass.
- Confirmed that production diagnostics already collect and stream the current Episode, but the canonical reference is not discoverable from the dashboard.
- Added an account-scoped `chalk.episode` alternate reference, direct Episode detail launch link, Developer launcher, and execution-trace coverage. The debugger still resolves to and displays the canonical reference for authorized sharing.
- Added a bounded, idempotent reconciler backfill so diagnostics created before the safe Episode reference become directly openable without an operator database update.
- The first bounded Sol review found two P2 release issues: a selected Episode could briefly expose a debugger link before its reference existed, and the completed reference backfill would still scan once per second.
- The dashboard now verifies the alternate reference through the signed-in same-origin gateway before rendering the debugger link, retries the short creation race, and leaves expired or unavailable diagnostics non-clickable with a manual Retry action.
- The API repository now serializes the legacy reference backfill, retries list or insert failures, and marks each environment complete only after an empty batch; later reconcile cycles skip the query. Focused Go tests, the race detector, focused web tests, and web type checking pass.
