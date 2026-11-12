# Call performance budgets

The call must stay responsive on constrained CPUs. The `call-performance` and `call-leaks` gate lanes build the real call-state fixtures in production mode and drive Chromium. The limits live in `perf/budgets.json`, the one budget file for every scorecard metric (see [the scorecard](../features/scorecard/README.md)). The measurement code is `apps/web/scripts/check-call-performance.mjs`. Read the script for scenarios, metrics and flags.

## What CI enforces

CI enforces the deterministic parts only: gzip size limits for the call route and call states, and the lifecycle leak counts. It does not enforce timing limits. A shared runner is not a controlled timing environment, and the timing limits were measured on a dedicated 8-vCPU, 16-GiB runner. A timing from any other machine is not a budget result until the budgets are re-measured there.

Run direct diagnostics with `--bundle-only` unless you are re-measuring on a reference runner. `--record-baseline` collects data without enforcing limits, so never use it to claim a pass. Run browser work on Instabox, not the laptop; see [gate operations](../scripts/gates/README.md). The pre-commit fast profile does not run browser measurements.

## What the measurement can and cannot say

- The CPU profiles (4x laptop, 6x phone) are repeatable stress, not stand-ins for a physical device. CPU throttling does not model memory bandwidth, radio, thermals, mobile GPU or real video decode.
- Fixture cameras are painted canvases. The result measures UI plus synthetic media work, not a 24-stream WebRTC decode. Treat the frame budgets as relative regression limits, not evidence of 60 fps on a real laptop. Keep the fixture settings unchanged when comparing revisions.
- A blank-page frame-clock control runs before each device. A capped or overloaded clock fails the run instead of passing silently.
- Event Timing includes presentation delay and has a 16 ms floor. A zero means below the floor, not instant.
- A zero decoded-frame denominator means nothing was measured, not perfect playback.
- Per-scenario bundle sizes describe the call-state entry with fixture overhead. The route sizes describe the real call route. The two bundling graphs differ, so do not compare them.
- Twenty same-document lifecycle cycles cannot prove the absence of slow leaks, browser or native leaks, or leaks that need real transports, device changes or long sessions. Never widen a count budget to absorb a real leak.

## Changing a budget

Change a budget in its own pull request that edits `perf/budgets.json` and adds a reason line to `_comment`. Give the user trade-off, old and new measurements (at least five repetitions on the same class of runner with min, median, max, CPU and Chromium version), and why the cost is worth it. Do not raise a budget to turn CI green. Compare production code against the pinned baseline commit in the data file, never against whichever revision passes today. Commit new measurements separately from product changes.

## References

- [CDP CPU slowdown](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate)
- [CDP performance metrics](https://chromedevtools.github.io/devtools-protocol/tot/Performance/#method-getMetrics)
- [Event Timing specification](https://www.w3.org/TR/event-timing/)
