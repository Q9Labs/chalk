# Space experience profiler

This directory contains a dependency-free Playwright and CDP profiler for the full Chalk Space surface. It creates three or four isolated headless Participants with fake camera and microphone devices. An init override maps `getDisplayMedia` to a fake `getUserMedia` video stream, so screen sharing stays deterministic. Chromium's physical audio output is muted, while microphone tracks and in-app audio attachment still execute.

Start the isolated local stack, then run a short validation:

```sh
node scratchpad/perf-harness/dev-stack.mjs --up
```

The stack launcher defaults to the normal local PostgreSQL container but recreates only the `chalk_perf_profile` database. Set `CHALK_PERF_DATABASE_NAME`, `CHALK_POSTGRES_CONTAINER`, `CHALK_POSTGRES_VOLUME`, `CHALK_REDIS_CONTAINER`, and `CHALK_REDIS_VOLUME` to give a remote or concurrent run unique resources. It reads `CHALK_CLOUDFLARE_REALTIME_APP_ID` and `CHALK_CLOUDFLARE_REALTIME_APP_SECRET` together when they are present; otherwise it resolves the local development credentials through 1Password.

Run the validation:

```sh
node scripts/performance/space-experience/cli.mjs shakedown --seconds 60 --participants 3 --base http://127.0.0.1:13070
```

Run the required long runtime profile:

```sh
node scripts/performance/space-experience/cli.mjs profile --minutes 30 --participants 4 --base http://127.0.0.1:13070
```

Run the heap snapshot pass separately after the runtime profile:

```sh
node scripts/performance/space-experience/cli.mjs shakedown --snapshot-pass --seconds 60 --participants 4 --base http://127.0.0.1:13070
```

Run targeted browser traces in their own pass:

```sh
node scripts/performance/space-experience/cli.mjs shakedown --trace-pass --seconds 60 --participants 4 --base http://127.0.0.1:13070
```

The three passes have different measurement purposes. The long profile keeps the five-second sampler and full Participant CPU profiles enabled, but skips browser traces and heap snapshots so their collection cost cannot contaminate runtime CPU. The trace pass disables continuous sampling and CPU profiling, runs one full workload cycle, and records the targeted browser and LayerTree windows. The snapshot pass also runs one cycle, captures the join/leave/panel raw snapshots, and summarizes them only after Chromium closes. All modes enforce their duration range and the three-to-four Participant range; the one-cycle passes still validate their shakedown duration. The public smoke path needs no saved login state. Pass `--storage-state <path>` only when the local app is configured to require the smoke-test login. Artifacts go to a unique `.private/chalk-perf/runs/<mode>-<id>` directory with a running, passed, or failed manifest whose `measurement.kind` is `runtime-profile`, `trace-pass`, or `snapshot-pass`.

The workload uses visible Playwright pointer actions. It checks exact roster counts, media state on a remote Participant, screen share video and zoom/pan, all three layouts, tile pin changes, each reachable panel, the Waiting participant group, chat send/receive/history, a sent and remotely received file, hand raise, reactions, whiteboard drawing/pan/zoom and remote cursors, and leave/rejoin. An explicit idle window runs in every cycle. Transcript reachability, the Waiting group when admission is disabled, and participant tile dragging are recorded in `feature-support.json`; unreachable or unsupported behavior is never counted as a pass.

Runtime-profile CDP samples are serialized every five seconds for every Participant. Each row includes drift, deltas, and errors, while a browser-level CDP channel records browser, renderer, utility, and GPU-process CPU. Drift rows also record the host's one-, five-, and fifteen-minute load averages so shared-host contention remains visible. After all initial joins, every Participant receives a sampling CPU profile for the complete timed workload, including ranked application frames. Re-entry uses the visible `Try again` flow so renderer profiles stay attached, and the runtime profile fails if any profile covers less than 95 percent of the longest Participant profile. The snapshot pass captures raw heap snapshots for self join, remote joins, remote leave/rejoin, and baseline/open/closed for every reachable panel. It summarizes heap JSON and writes heap diffs only after all Participant contexts and Chromium close. The trace pass covers camera/video, reaction and hand animations, screen share video and zoom/pan, chat-history scroll, and whiteboard drawing and remote cursors. Trace records count paint, layout, raster, compositor, GPU, and animation work, normalized by Participant-seconds for comparisons; non-trace passes still execute the same actions without recording traces.

Analyze one run or compare two runs:

```sh
node scripts/performance/space-experience/analyze.mjs .private/chalk-perf/runs/<run>
node scripts/performance/space-experience/compare.mjs .private/chalk-perf/runs/<before> .private/chalk-perf/runs/<after>
```

Focused pure tests run with:

```sh
node --test scripts/performance/space-experience/test/pure.test.mjs
```
