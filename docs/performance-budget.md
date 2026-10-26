# Call performance budgets

The call must remain responsive on constrained CPUs. The `call-performance`
gate builds the real call-state fixtures in production mode and drives Chromium;
it does not time Vite's development server, a screenshot, or a loading placeholder.
The machine-readable limits are in `apps/web/perf-budgets.json`.

## Run

Run heavy work on Instabox with `box run`, not on the laptop. Commit and push first;
see [gate operations](../scripts/gates/README.md) for runner setup:

```sh
box run -- 'pnpm install --frozen-lockfile && pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium && node apps/web/scripts/check-call-performance.mjs --self-test --bundle-only'
```

The focused timing gate is `pnpm run gate -- --lane call-performance --files
apps/web/src/call-states/performance.tsx`; the lifecycle gate uses `--lane
call-leaks` instead. Run both on Instabox. The root gate selects both for web,
React SDK, UI, whiteboard and dependency changes, and full gates. The PR Gate
workflow already runs this root gate and installs Chromium.
The pre-commit fast profile deliberately does not run browser measurements.

Gate lanes enforce bundle size and lifecycle leaks everywhere, including
GitHub Actions. Timing limits are not enforced by gate mode on uncalibrated runners: `--gate` runs select bundle-only mode,
while `--gate --leaks-only` still measures and enforces leaks. This is an
explicit policy, not an automatic retry or a pass after noisy timing failures.
Direct diagnostic runs must use `--bundle-only` until this runner has calibrated limits.
`--skip-build` reuses a previously built harness only for diagnosis.

The console prints measured median/budget pairs. JSON defaults to
“artifacts/call-performance.json” and contains every sample, min/median/max,
loaded initial and lazy resources, browser version, CPU, load, calibration,
errors and failures. `--out` changes the path. A broken budget, missing explicit scenario limit, or missing
observation exits nonzero. `--record-baseline` collects data without enforcing
limits; it is not a gate and must not be used to claim a pass.

## What each number means

| Metric                | User meaning and measurement                                                                                                                                                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `frameP95Ms`          | Stuttering: p95 interval between `requestAnimationFrame` callbacks in the scenario window. Lower is better.                                                                                                                                                                                                                         |
| `droppedFramePercent` | Missed 60 Hz frame opportunities, estimated by rounding each rAF interval to 16.67 ms slots. This is not a GPU/compositor dropped-video-frame counter.                                                                                                                                                                              |
| `longTasks`           | Main-thread tasks over 50 ms, observed with the Long Tasks API.                                                                                                                                                                                                                                                                     |
| `blockingMs`          | Sum of each long task's duration minus 50 ms, in the measured window. This is scenario blocking time, not Lighthouse navigation TBT.                                                                                                                                                                                                |
| `interactionMs`       | Worst Event Timing duration matched by timestamp to trusted pointer/click input in the scenario. The panel scenario requires four trusted clicks (touch taps on phones). Chromium suppresses events under 16 ms; zero means below the reporting floor, not literally zero latency. Non-interactive scenarios have no latency claim. |
| `heapMiB`             | JS heap in use after the scenario, from CDP `Performance.getMetrics`; no forced GC hides allocation pressure. Not process RSS, GPU memory or a leak proof.                                                                                                                                                                          |
| `domNodes`            | CDP `Memory.getDOMCounters` nodes, including detached nodes retained at sampling time.                                                                                                                                                                                                                                              |
| `firstCallMs`         | Cold navigation to at least one decoded on-screen camera and a visible Leave call control plus two animation frames, including JS execution and initial rendering. Off-screen carousel videos need not decode. Loopback, no live authentication, signaling or network latency.                                                      |
| `jsGzipKiB`           | Unique loaded script bodies recompressed at gzip level 9, including lazy chunks reached by each scenario.                                                                                                                                                                                                                           |
| `cssGzipKiB`          | Same for loaded stylesheets, including the board stylesheet. Remote font downloads are replaced by an empty CSS stub (20 gzip bytes).                                                                                                                                                                                               |

Every scenario runs five times in a fresh context, with cache disabled. Each
budget compares the median of those five observations, not the fastest run.
Idle windows last three seconds after one second's settling. Clicks, board
pointer work, reaction injection and both reconnect transitions occur inside
the measured window. First load includes startup instead of resetting it.

The scenarios are six cameras, 24 cameras in Grid, Chat/People open and close,
Spotlight screen sharing, a loaded board, 24 simultaneous reactions, reconnect
limbo entry/recovery, and first call load. The fixtures use the SDK's real Chalk
component; hidden fixture buttons only supply remote state transitions.

## Limits of the measurement

The laptop profile is 1366×768 at 4× CDP CPU slowdown; the phone is 390×844,
touch/mobile enabled, at 6×. These are repeatable CPU stress profiles, not claims
of equivalence to a particular physical laptop or phone. CPU throttling does
not model memory bandwidth, radio, thermals, mobile GPU or real video decode.

The budgets were measured on Testbox's 8-core box. An Instabox timing is not a budget result until the budgets are re-measured there.
The former reference runner had 8 dedicated vCPUs and 16 GiB of memory.
Re-measuring the budgets is separate work. The throttle factors stress main-thread work while keeping the
same viewport and media workload; they do not throttle native video/compositor
threads as a real slow device would. Blank-page and unthrottled/paused-video
controls distinguish a capped browser clock from loaded rendering costs.

A blank-page rAF control runs before each device. Full timing runs fail if its
p95 exceeds 25 ms or its median falls below 12 ms: a capped or overloaded clock
must not silently pass. The report retains cadence and host load. Shared
GitHub runners are not a controlled timing environment, so their timing values
are diagnostic only; deterministic gzip limits remain enforced there.

Fixture cameras are painted canvases, 640×360, repainted every 500 ms and
captured at 4 fps; the screen is 1280×720. This measures UI plus synthetic media
work, not a 24-stream WebRTC decode benchmark. Keep those settings unchanged
when comparing revisions. A real-media device study remains separate. `--diagnostics` additionally runs
one paused-video and one unthrottled active-video control per device; these
controls explain the limiter, not a five-run product speedup. The reference probe
showed laptop p95 16.8 ms with video paused versus 66.7 ms with video active
and CPU throttle removed. Treat the active synthetic-video frame budgets as
relative regression limits, not evidence of 60 fps on a physical laptop.
Event Timing includes presentation delay, so this rendering cost can also
increase panel latency; it is not a measurement of handler execution alone.

The board must mount a visible Excalidraw canvas before sampling completes.
Its version-pinned installed stylesheet is fulfilled locally at the production
CDN URL, eliminating CDN availability noise without substituting empty CSS.
Google fonts are excluded; system fallback fonts are used consistently.

The script also builds the real web app and loads `/space/performance-budget`
from its prepared production SPA shell. `routeJsGzipKiB` and `routeCssGzipKiB`
measure the actual call route's initial loaded resources, including its router
shell. External API/analytics/font traffic is fulfilled locally; no live join
is attempted. A visible Join control proves that the route mounted.

The per-scenario JS/CSS numbers belong to the production **call-state entry**,
including fixture overhead and the lazy board chunks reached by that scenario.
Keep these separate from the real route's initial bytes: their bundling graphs
are not identical. Neither figure claims to include lazy features not exercised
by these scenarios (for example, board math insertion).

## Changing a budget

Change a budget deliberately in its own commit. Include the user trade-off,
old and new measurements (at least five repetitions on the same class of
runner), min/median/max, CPU and Chromium version, and why the added cost is
worth accepting. Do not raise a budget merely to turn CI green. Compare the
production code against the pinned baseline commit in the data file; do not
silently replace it with whichever revision happens to pass today.

`--self-test` installs a temporary busy loop of at least 250 ms in trusted click
handling, sized above the configured interaction/blocking budgets. It feeds the
result through the same budget evaluator as a normal run and requires an actual
budget failure plus Long Tasks and Event Timing evidence, then closes the
context. Add `--self-test` to a bundle-only diagnostic to exercise this timing injection.
The leak gate includes its own injected-leak self-test automatically.
It never writes a slowdown into product source. Normal measurements run
without this injection. The test does not persist a slowdown or raise a limit.

To propose a candidate without silently editing policy:

```sh
pnpm --dir apps/web run perf:call:propose --baseline ../../artifacts/baseline.json --out ../../artifacts/proposed-budgets.json
```

The proposer requires all 16 scenario/device results with at least five samples.
For non-bundle metrics it uses the larger of median +25% and maximum +15%, plus
small absolute floors. Missed-frame percentage uses +3 percentage points over
the median or +2 over the maximum, capped at 99.5%. Deterministic gzip limits
have 3% headroom rounded up to KiB. A human still reviews the candidate and
commits the reason and new measurements separately from product changes.

## Baseline

The production baseline is `d3cb32526401f033327b8449d01050e600c84cd7`.
The measurement overlay adds fixtures and instrumentation, without changing SDK,
UI, whiteboard, production route or call-component source. Baseline and clean
measurements use this same production code. The proposer rejects a report whose
source revision differs from the pinned baseline.

Recorded 2026-10-18 on a dedicated `c-8` (8 vCPU, 16 GiB), Intel Xeon
Platinum 8280 at 2.70 GHz, Linux x64, Chromium `151.0.7922.34`.
Each row contains five independent contexts. Cells are **median [minimum–maximum] / budget**.
These are bootstrap regression limits, not acceptable physical-device smoothness targets.

### Frames

| Device / scenario        | Frame p95 (ms)            | Missed 60 Hz opportunities (%) |
| ------------------------ | ------------------------- | ------------------------------ |
| laptop / calm-six        | 66.7 [66.7–66.7] / 89     | 57.4 [55.0–58.4] / 61          |
| laptop / grid-24         | 66.7 [66.7–100.0] / 120   | 61.8 [61.4–65.0] / 67          |
| laptop / panels          | 66.8 [66.7–83.3] / 101    | 67.3 [66.4–67.7] / 71          |
| laptop / spotlight-share | 66.8 [66.7–100.0] / 120   | 60.1 [58.6–63.1] / 66          |
| laptop / board           | 83.3 [66.7–83.4] / 110    | 59.1 [57.2–60.7] / 63          |
| laptop / reactions       | 100.0 [66.8–100.1] / 130  | 76.1 [75.3–79.7] / 82          |
| laptop / reconnect       | 99.9 [99.9–100.0] / 130   | 62.3 [62.2–62.4] / 66          |
| laptop / first-load      | 100.1 [100.0–133.4] / 159 | 63.5 [63.0–69.3] / 72          |
| phone / calm-six         | 33.4 [33.4–33.4] / 47     | 50.0 [50.0–50.0] / 53          |
| phone / grid-24          | 33.4 [33.4–33.4] / 47     | 50.0 [50.0–50.6] / 53          |
| phone / panels           | 50.0 [50.0–66.7] / 82     | 48.2 [46.7–53.3] / 56          |
| phone / spotlight-share  | 33.4 [33.4–33.4] / 47     | 50.0 [50.0–50.0] / 53          |
| phone / board            | 16.8 [16.8–33.2] / 44     | 3.7 [2.3–6.3] / 9              |
| phone / reactions        | 33.4 [33.4–33.4] / 47     | 50.0 [50.0–50.0] / 53          |
| phone / reconnect        | 33.4 [33.4–33.4] / 47     | 50.6 [50.3–50.8] / 54          |
| phone / first-load       | 83.3 [50.0–83.4] / 110    | 59.4 [58.2–60.6] / 63          |

### Blocking and input

| Device / scenario        | Long tasks   | Blocking (ms)          | Trusted interaction (ms)  |
| ------------------------ | ------------ | ---------------------- | ------------------------- |
| laptop / calm-six        | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| laptop / grid-24         | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| laptop / panels          | 5 [4–6] / 9  | 105 [63–117] / 160     | 384.0 [368.0–440.0] / 530 |
| laptop / spotlight-share | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| laptop / board           | 0 [0–0] / 2  | 0 [0–0] / 25           | 200.0 [192.0–272.0] / 337 |
| laptop / reactions       | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| laptop / reconnect       | 1 [1–1] / 4  | 25 [24–28] / 58        | 0.0 [0.0–0.0] / 24        |
| laptop / first-load      | 5 [5–5] / 9  | 625 [560–710] / 842    | 0.0 [0.0–0.0] / 24        |
| phone / calm-six         | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| phone / grid-24          | 0 [0–1] / 4  | 0 [0–12] / 39          | 0.0 [0.0–0.0] / 24        |
| phone / panels           | 4 [3–7] / 11 | 247 [214–283] / 351    | 304.0 [272.0–344.0] / 420 |
| phone / spotlight-share  | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| phone / board            | 0 [0–0] / 2  | 0 [0–0] / 25           | 96.0 [96.0–104.0] / 144   |
| phone / reactions        | 0 [0–0] / 2  | 0 [0–0] / 25           | 0.0 [0.0–0.0] / 24        |
| phone / reconnect        | 3 [3–3] / 6  | 83 [70–96] / 136       | 0.0 [0.0–0.0] / 24        |
| phone / first-load       | 5 [5–5] / 9  | 1026 [975–1065] / 1308 | 0.0 [0.0–0.0] / 24        |

Zero interaction observations in non-interactive scenarios are not latency measurements.

### Memory and first render

| Device / scenario        | JS heap (MiB)         | DOM nodes               | First call (ms)               |
| ------------------------ | --------------------- | ----------------------- | ----------------------------- |
| laptop / calm-six        | 10.5 [10.3–10.7] / 16 | 1496 [1496–1496] / 1920 | —                             |
| laptop / grid-24         | 10.6 [10.4–11.3] / 16 | 5194 [5194–5194] / 6543 | —                             |
| laptop / panels          | 11.7 [11.7–11.8] / 17 | 1924 [1924–1924] / 2455 | —                             |
| laptop / spotlight-share | 10.4 [10.0–10.8] / 15 | 1732 [1732–1732] / 2215 | —                             |
| laptop / board           | 13.4 [10.4–14.1] / 19 | 1792 [1445–1792] / 2290 | —                             |
| laptop / reactions       | 10.5 [10.3–10.6] / 16 | 1554 [1554–1554] / 1993 | —                             |
| laptop / reconnect       | 10.9 [10.9–10.9] / 16 | 1517 [1517–1517] / 1947 | —                             |
| laptop / first-load      | 9.6 [9.5–9.7] / 14    | 1496 [1496–1496] / 1920 | 1391.4 [1360.0–1530.7] / 1861 |
| phone / calm-six         | 10.4 [10.4–10.7] / 15 | 1534 [1534–1534] / 1968 | —                             |
| phone / grid-24          | 10.4 [9.5–11.2] / 16  | 5234 [5234–5234] / 6593 | —                             |
| phone / panels           | 11.6 [11.6–12.4] / 17 | 1814 [1814–1814] / 2318 | —                             |
| phone / spotlight-share  | 10.6 [10.6–10.6] / 16 | 1746 [1746–1746] / 2233 | —                             |
| phone / board            | 13.3 [10.5–13.7] / 19 | 2003 [1623–2003] / 2554 | —                             |
| phone / reactions        | 10.5 [10.5–10.7] / 16 | 1592 [1592–1592] / 2040 | —                             |
| phone / reconnect        | 10.8 [10.1–10.8] / 16 | 1555 [1555–1555] / 1994 | —                             |
| phone / first-load       | 9.6 [9.6–9.6] / 15    | 1534 [1534–1534] / 1968 | 1918.7 [1889.8–1973.8] / 2499 |

### Loaded bundles

Every repeated bundle observation was identical at the displayed precision.
The board row includes its lazy code; other fixture scenarios share the initial graph.

| Entry / scenario            | JS gzip KiB [range] / budget | CSS gzip KiB [range] / budget |
| --------------------------- | ---------------------------- | ----------------------------- |
| Call-state entry / calm-six | 370.7 [370.7–370.7] / 382    | 52.3 [52.3–52.3] / 54         |
| Call-state entry / board    | 721.1 [721.1–721.1] / 743    | 52.3 [52.3–52.3] / 54         |
| Actual call route / initial | 450.3 / 464                  | 30.1 / 32                     |

### Calibration and interpretation

Both blank-page controls had a 16.7 ms median and 16.8 ms p95.
Paused-video p95 was 16.8 ms (laptop) and 16.7 ms (phone). Removing CPU
throttling while leaving synthetic video active gave 66.7 ms and 33.4 ms.
This isolates substantial synthetic-video/compositor cost, not a 15 Hz headless
clock cap. The 4×/6× profiles remain CPU stress settings from the brief, not
hardware-calibrated equivalents; the controls remain stable at both factors.

All 24 fixture cameras have live synthetic tracks. Chromium decoded 21 visible
videos in the first laptop Grid sample and eight in the phone sample; off-screen
videos were suspended. This is a 24-camera UI workload, not 24 simultaneous
native video decoders. That optimization is retained rather than bypassed.

The highest-priority follow-up is real-media device profiling and reducing panel
presentation delay. Do not widen the frame/interaction limits to claim smoothness.
Deterministic bundle limits are the strongest immediate shipping guard. Memory
and DOM headroom are deliberately conservative until the integrated redesign is measured.

## API references

- [CDP CPU slowdown](https://chromedevtools.github.io/devtools-protocol/tot/Emulation/#method-setCPUThrottlingRate).
- [CDP performance metrics](https://chromedevtools.github.io/devtools-protocol/tot/Performance/#method-getMetrics).
- [Event Timing specification](https://www.w3.org/TR/event-timing/): 16 ms observation floor and quantized durations.

## Leaks

Full performance gates also run eight lifecycle journeys: leave/rejoin,
Chat/People open/close, participant join/leave, share start/stop, board open/close,
reconnecting/recovered, Spotlight/Grid, and a 24-reaction burst. Each runs once to
warm caches, then 20 times in the **same document**. Leave is sampled while left;
the next cycle rejoins before leaving again. Other journeys return to their
initial UI state. No reload can discard evidence between cycles.

Each sample waits 600 ms for effect/animation teardown, collects garbage through
CDP, yields another 200 ms, and collects again. It repeats until two consecutive
resource-count readings agree (up to six pairs); it never selects a minimum.
Failure to stabilize is a measurement failure. Reaction cycles additionally wait
4.3 seconds for the four-second burst expiry. Board warm-up waits for its lazy
canvas. Counts are collected without holding application objects strongly:

- `heapMiB`: V8 JS heap after collection; excludes GPU, canvas/native video
  buffers, browser process memory and most decoder memory.
- `domNodes`, `listeners`, `documents`: CDP DOM counters, including detached
  nodes/listeners still retained by JavaScript, not just attached DOM queries.
- `videos`, `audios`: media elements still alive after GC, including retained detached elements.
  Creation wrappers and a mutation observer register them weakly.
- `liveTracks`: distinct non-ended track wrappers observed through canvas/media
  capture, media-device calls, stream additions, track cloning and Web Audio
  destinations. Weak references do not prevent collection. This is not a native
  media-process census or an instrumentation of arbitrary third-party realms.
- `rosterCacheKeys`: distinct departed synthetic guest IDs still present as keys
  in a live Map. Guest IDs change each join, while fake camera names stay fixed
  so source caching stays bounded. Map registration is weak and does not keep a
  cache alive. A one-key allowance covers an alternate React render; sustained
  growth fails. This focused counter catches the confirmed first-seen map leak
  even though each entry is too small to separate reliably from heap noise.
- `audioContexts`: observed AudioContexts that have not closed, including suspended
  contexts. Closed contexts do not count.
- `intervals`: scheduled intervals not cancelled. `animationFrames`: outstanding
  callbacks, including self-rescheduling animation loops. A pending one-shot RAF
  can vary by one; these counters measure scheduled work, not CPU consumption.

`apps/web/perf-budgets.json` owns the cycle count, settle delay and per-metric
budgets. Ordinary least-squares slope includes the warm baseline (cycle zero).
A journey fails if **either** slope exceeds `perCycle` or any subsequent sample
exceeds baseline plus `allowance`. Heap also checks the last ten samples against
`tailPerCycle` (0.05 MiB/cycle), so startup headroom cannot mask ongoing growth.
The whole-run heap limits are 0.1 MiB/cycle and 3 MiB above baseline. Thus a fixed leak cannot hide behind a flat
slope, and slow sustained growth cannot hide behind fixed headroom. After full
leave, tracks and AudioContexts must be exactly zero even if unchanged from the
warm baseline. Missing measurements and invalid budgets fail closed.

The fixture owns synthetic canvas sources and paint intervals; full leave clears
its snapshot, stops those sources and clears their intervals. It does not stop
SDK-owned track clones, close SDK AudioContexts or clear SDK timers. While joined,
synthetic camera/share sources are cached under fixed names; warm-up includes
those caches. These are preview-client UI lifecycles, not a live client's network
join/leave or WebRTC teardown proof. Excalidraw's first-open module/cache allocation
belongs before baseline. Growth on later opens must still pass the same limits.

On failure only, `artifacts/call-leaks/run-*/*.heapsnapshot` holds a Chromium snapshot. Each invocation gets its own directory, so a
calibration and a subsequent gate cannot overwrite each other’s evidence.
Load it in DevTools **Memory → Load**, use Comparison against a separately captured
baseline when needed, and inspect retainers of detached nodes. The report prints
native detached-node count and the largest retained object types. Diagnostic
summaries compute dominators over strong edges: `largestRetainedBytes` is the
largest individual retained subtree for that type (not a sum of overlapping
subtrees); `shallowBytes` totals the type's own allocations. Snapshots can contain
application data: keep artifacts out of Git. Passing uninjected journeys take no
snapshots; the self-test's deliberate failures do produce snapshots.

`--self-test` runs panel cycles with two independent faults: an unreleased document
listener per panel open and retained detached sections per panel open. Each must
fail its actual count budget and generate evidence. An uninjected panel run must
then pass. The two injected probes use five cycles each; the uninjected comparison and all
ordinary journeys use 20. Expected injected failures do not themselves fail the gate. A separate blank-page
resource probe also proves that detached media elements, tracks, an AudioContext,
an interval and a self-rescheduling RAF are observed while live and return to zero
after teardown.

For calibration (three full repetitions of every journey), after building the
harness on Instabox:

```sh
node apps/web/scripts/check-call-performance.mjs --skip-build --leaks-only --leak-repeats 3 --self-test --out artifacts/leaks-calibration.json
```

An additional idle journey runs the same sampling and two no-op evaluations per
cycle without changing call state. It measures observer/automation heap noise.

Leak runs use an unthrottled desktop viewport to reduce timer/teardown timing
noise; timing scenarios still exercise both CPU-throttled device profiles.
For a focused diagnostic, add `--leak-journey people`; gate mode rejects narrowed
journeys. The root gate invokes `--gate --timing-only` and `--gate --leaks-only`
as separate required lanes, with different JSON reports. A direct invocation
without either flag still runs both. The combined reference run passed 11 minutes
before starting leak cycles, so leaks have their own lane to keep timing checks
under about 15 minutes. Each lane builds its own harness; no build-directory
sharing or background server is required.

Do not widen a count budget to absorb a real leak. Finite 20-cycle tests cannot
prove absence of slower leaks, browser/native leaks, production SDK media leaks,
or leaks triggered only by real transports, device changes or long sessions.

### Calibration and known findings (2026-10-18)

Count calibration used shared 4-vCPU machines; historical timing verification used the
dedicated 8-core reference runner described above. Shared-run timing numbers are
not comparable with the reference budgets. Only complete 21-sample journeys
count toward the calibration spread; an interrupted three-repeat command is not
a successful full run.

Blank-page controls measured heap slopes of 0.000012 MiB/sample without the
observer and 0.000852 with it. The idle call without instrumentation initially
grew by 0.0386 MiB/sample over 20 cycles, but over 120 cycles its overall slope was
0.00440 and its final 21-sample slope was 0.00312. Panel and layout controls over
60 cycles had final 21-sample slopes of 0.0172 and 0.00946 respectively. These
controls expose startup/JIT/cache growth, not a zero-allocation call. Across
completed ordinary journey observations, early whole-run heap slopes reached
about 0.073 MiB/cycle and final-ten slopes about 0.044. The 0.1/3 MiB whole-run
limits and 0.05 tail limit leave headroom above those observations; the fixed
count budgets independently catch smaller retained resources.

Fresh guest IDs expose a real failure in the current SDK: the stage's
`seenAtRef` map retains departed participant IDs. One warm guest plus 20 cycles
leaves 21 guest keys, growing by one per cycle. The `rosterCacheKeys` budget stays
at 0.1 keys/cycle with a fixed allowance of one, so the gate remains red until
the SDK is fixed. The measurement lane deliberately does not edit SDK components.
Full leave clears the map by unmounting; repeated guest departure while the call
stays mounted is the failing journey.

The dedicated reference run also measured laptop panel layout shift at a median
0.3287 (five samples: 0.2544–0.3477), above the unchanged 0.05 limit. Attribution
includes the drawer's changing width and the call controls moving horizontally
(one recorded controls rectangle moved from x=215 to x=378.47). These entries
have recent input, which this interaction-focused signal intentionally includes.
Do not interpret it as standard Core Web Vitals CLS. The same run's phone
first-load frame p95 exceeded its existing timing limit (116.6 ms versus 110 ms);
that limit was not widened either. The combined command took 18.79 minutes,
confirming the need for the separate leak lane.

The final separate reference lanes took 9.98 minutes for timing and 8.94 for
leaks, including their builds and self-tests. Both reported no measurement
errors. Timing failed only the panel shift (median 0.3388); leaks failed only
the retained guest keys. The phone first-load timing passed that repetition.
All 22 focused metric/routing tests, resource lifecycle probes, injected fault
checks, the uninjected 20-cycle panel comparison and the web typecheck passed.
At least four complete observations cover every ordinary journey's original
counters; the newer guest-key counter has five People observations and at least two per
other ordinary journey. This finite spread is calibration evidence, not a claim
that all counts were collected on every earlier revision.

### Additional rendering signals

Timing scenarios also record `videoDroppedFramePercent` from visible videos'
`getVideoPlaybackQuality()` counter deltas (not compositor frame estimates), and
`layoutShift` from layout-shift entries during the measurement window. The latter
includes recent-input entries deliberately: a panel-induced jump is still a jump.
Transform motion does not contribute. A zero video denominator means no decoded
frames were measured, not perfect playback; the report retains frame counts.
Playback is sampled at 4 Hz with weak per-element state. Decoder counters can
reset while the same video element survives a panel change; reset generations
contribute their new counts rather than negative deltas. The report retains
frame/drop counts, observed resets and sample counts. Visibility is sampled,
not continuous; multiple resets between samples can lose frames. Layout-shift
entries retain source rectangles and recent-input flags for diagnosis.
The limits are 5% decoder drops and 0.05 cumulative shift per window.
