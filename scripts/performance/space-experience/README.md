# Space experience profiler

This directory contains a dependency-free Playwright and CDP profiler for the full Chalk Space surface. It creates three or four isolated headless Participants with fake camera and microphone devices. An init override maps `getDisplayMedia` to a fake `getUserMedia` video stream, so screen sharing stays deterministic.

Start the local stack with `pnpm dev`, then run a short validation:

```sh
node scripts/performance/space-experience/cli.mjs shakedown --seconds 60 --participants 3 --base http://127.0.0.1:13070
```

Run the required long profile:

```sh
node scripts/performance/space-experience/cli.mjs profile --minutes 30 --participants 4 --base http://127.0.0.1:13070
```

Both modes enforce their duration range and the three-to-four Participant range. The duration is the scripted workload target; browser setup, heap snapshots, and cleanup can extend wall-clock time. The public smoke path needs no saved login state. Pass `--storage-state <path>` only when the local app is configured to require the smoke-test login. Artifacts go to a unique `.private/chalk-perf/runs/<mode>-<id>` directory with a running, passed, or failed manifest.

The workload uses visible Playwright pointer actions. It checks exact roster counts, media state on a remote Participant, screen share video and zoom/pan, all three layouts, tile pin changes, each reachable panel, the Waiting participant group, chat send/receive/history, a sent and remotely received file, hand raise, reactions, whiteboard drawing/pan/zoom and remote cursors, and leave/rejoin. An explicit idle window runs in every cycle. Transcript reachability, the Waiting group when admission is disabled, and participant tile dragging are recorded in `feature-support.json`; unreachable or unsupported behavior is never counted as a pass.

CDP samples are serialized every five seconds for every Participant. Each row includes drift, deltas, and errors, while a browser-level CDP channel records browser, renderer, utility, and GPU-process CPU. The anchor Participant receives a whole-run sampling CPU profile in `finally`, including ranked application frames. Heap snapshots cover self join, remote joins, remote leave/rejoin, and baseline/open/closed for every reachable panel. Synchronized feature traces cover camera/video, reaction and hand animations, screen share video and zoom/pan, chat-history scroll, and whiteboard drawing and remote cursors. Trace records count paint, layout, raster, compositor, GPU, and animation work, normalized by Participant-seconds for comparisons.

Analyze one run or compare two runs:

```sh
node scripts/performance/space-experience/analyze.mjs .private/chalk-perf/runs/<run>
node scripts/performance/space-experience/compare.mjs .private/chalk-perf/runs/<before> .private/chalk-perf/runs/<after>
```

Focused pure tests run with:

```sh
node --test scripts/performance/space-experience/test/pure.test.mjs
```
