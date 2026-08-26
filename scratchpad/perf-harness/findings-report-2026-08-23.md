# Chalk web Space experience pre-fix profile (2026-08-23)

This report is the numbered pre-fix record. It separates measured behavior from
static hypotheses so that each correction can be rerun against the same
contract.

## Scope and validity

- Product revision: `bde30e42`.
- Harness revision: `edb411cc`.
- Test surface: local Go API, Elixir sync server, and Vite web app on the M4
  test Mac.
- Workload: four Chromium pages with fake media, 26 complete interaction
  cycles over 1,939.530 seconds.
- Sampling: serialized five-second CDP metrics, process CPU, and host load.
- Profiles: one full CPU profile for each Participant page. All four profiles
  covered 1,944.5 to 1,944.9 seconds with 99.98% duration parity.
- Focused evidence: seven hardware-Metal trace windows and 20 forced-GC heap
  snapshots across 17 paired diffs.

The app ran in Vite development mode because the workload needed the local
stack. React development instrumentation is called out below. The shared host
averaged 5.515 load on 10 logical CPUs and peaked at 12.269, so process CPU is
useful for identifying shape and hotspots, not for a clean machine-wide
benchmark.

The workload did not pass its product assertions. Remote media reconciliation,
camera disable, screen share, attachment staging, Board activation, and
re-entry all failed at least once. These failures are findings, not harness
allowances, and they must be corrected before the final performance comparison
is valid.

## Durable artifacts

All raw artifacts are retained under `.private/chalk-perf/runs/` and remain
untracked.

| Evidence | Run ID | Result |
|---|---|---|
| 30-minute runtime and CPU profiles | `profile-2026-08-23T18-26-19-285Z-999rzs` | 26 cycles; product assertions failed |
| Focused trace windows | `shakedown-2026-08-23T18-59-08-163Z-o1yc6l` | Seven trace windows captured; product assertions failed |
| Forced-GC snapshots | `shakedown-2026-08-23T19-07-16-546Z-x0gvh8` | 20 snapshots and 17 diffs captured; product assertions failed |

The reproduction commands are:

```sh
node scripts/performance/space-experience/cli.mjs profile \
  --minutes 30 --participants 4 --base http://127.0.0.1:13070
node scripts/performance/space-experience/cli.mjs shakedown \
  --trace-pass --seconds 60 --participants 4 --base http://127.0.0.1:13070
node scripts/performance/space-experience/cli.mjs shakedown \
  --snapshot-pass --seconds 60 --participants 4 --base http://127.0.0.1:13070
```

## Runtime baseline

### Coverage results

| Behavior | Passed | Failed | Notes |
|---|---:|---:|---|
| Join | 4 | 0 | All four Participant pages joined |
| Roster | 5 | 0 | Initial and remote roster checks passed |
| Microphone cycle | 7 | 19 | Later non-anchor cycles failed during the SFU error storm |
| Camera | 1 | 1 | Disable left a media track active |
| Layout selection | 26 | 0 | Grid, Spotlight, and Presentation paths passed |
| Pin, reaction, hand | 78 | 0 | Each behavior passed in all 26 cycles |
| Screen share | 1 | 1 | Remote screen share did not become visible |
| Screen-share zoom and pan | 0 | 1 | Could not run against visible shared content |
| Chat send, receive, history | 130 | 0 | Two pages received each of 26 sent messages |
| Native `File` attachment | 0 | 1 | Native `File` was mistaken for the SDK byte-input shape |
| Panel open and close | 260 | 0 | Chat, Participants, Settings, Info, and Reactions passed |
| Board | 0 | 1 | Exceeded 120 seconds; the control never became pressed |
| Leave | 1 | 0 | Remote Participant leave passed |
| Re-entry | 0 | 1 | Visible `Try again` could not rejoin after 90 seconds |

Browser diagnostics recorded 2,898 HTTP 503 responses and five HTTP 500
responses. Avery emitted 1,102 of the 503 responses, Blake emitted two, Casey
emitted 899, and Devon emitted 895. Console messages that duplicate these HTTP
failures are not counted again.

### Endpoint counter changes

These are first-to-last renderer counters over about 32.5 minutes. They are not
leak verdicts because the UI and chat history remain live at the endpoint.

| Participant | Used JS heap | DOM nodes | Listeners | Documents | Layouts/min | Style recalculations |
|---|---:|---:|---:|---:|---:|---:|
| Avery | +68,521,136 B | +62,437 | +1,919 | +4 | 1,959.6 | +88,924 |
| Blake | +159,779,884 B | +48,570 | +1,476 | +1 | 3,299.7 | +113,423 |
| Casey | +52,085,468 B | +518 | +522 | +4 | 3,221.5 | +104,904 |
| Devon | +71,781,680 B | +956 | +598 | +1 | 3,172.0 | +103,032 |

The two chat-active pages account for nearly all DOM-node growth. The two
non-chat pages still have high layout and style-recalculation counters, so chat
does not explain the rendering churn by itself.

### Process and CPU-profile evidence

Average process CPU was 44.799% for the renderer aggregate, 22.703% for the GPU
process, 6.281% for the browser audio utility, 2.407% for the browser process,
0.824% for the network utility, and 0.672% for the capture utility. Renderer
CPU peaked at 147.346% and GPU CPU peaked at 42.416%.

Chromium was idle for 94% to 96% of samples. Garbage collection consumed 2.1
to 4.2 seconds per page across roughly 1,945 seconds. The largest named Chalk
application frame was `formatTime` in `ClassicMessageBubble`: 2.187 seconds of
self time for Avery and 1.322 seconds for Blake. The function creates a new
`Intl.DateTimeFormat` for each render. `ClassicChatPanel` added 0.482 seconds
of self time on Avery and 0.491 seconds on Blake. No comparable chat hotspot
appeared on Casey or Devon.

### Focused trace counts

Counts are normalized per Participant-second. Screen-share rows measure failed
wait paths, not valid shared-content rendering. The LayerTree paint-event
counter was empty and is not used.

| Window | Layout | Update tree | Paint | Raster | Commit | GPU task | Average peak layers |
|---|---:|---:|---:|---:|---:|---:|---:|
| Camera video | 3.251 | 3.310 | 6.721 | 0.785 | 3.650 | 0.705 | 46 |
| Chat history scroll | 5.977 | 5.977 | 12.702 | 7.995 | 7.397 | 6.127 | 45 |
| Hand animation | 5.933 | 6.497 | 12.612 | 4.695 | 8.790 | 3.367 | 41 |
| Idle | 3.335 | 3.405 | 8.941 | 4.795 | 4.911 | 4.725 | 46 |
| Reaction animation | 4.976 | 5.694 | 12.249 | 9.569 | 9.234 | 6.938 | 40 |
| Screen-share video wait | 2.387 | 2.490 | 5.236 | 1.828 | 2.952 | 3.697 | 47 |
| Screen-share zoom wait | 1.973 | 1.973 | 3.932 | 0.000 | 1.966 | 2.670 | 0 |

Relative to idle, chat scrolling raised Layout count by 79%, Paint by 42%,
Raster by 67%, Commit by 51%, and GPU-task count by 30%. Reaction animation
raised Paint by 37%, Raster by about 100%, Commit by 88%, and GPU-task count by
47%.

### Forced-GC heap evidence

No class name containing `detached` appears in any of the 17 forced-GC diffs.
Panel close operations also release nearly all panel Fibers and DOM. The
baseline-to-closed totals are:

| Panel | Node delta | Self-size delta | Relevant retained classes |
|---|---:|---:|---|
| Chat | +50,598 | +4,889,520 B | +23,994 `PerformanceMeasure`; +175 `HTMLDivElement`; +6 `FiberNode`; +3 `V8EventListener` |
| Participants | +10,380 | +584,988 B | +1,313 `PerformanceMeasure`; +2 `FiberNode`; +139 `V8EventListener` |
| Settings | +10,859 | +787,319 B | +421 `PerformanceMeasure`; +5 `FiberNode`; +53 `V8EventListener` |
| Info | +5,318 | +254,331 B | +327 `PerformanceMeasure`; no net panel DOM or Fibers |
| Reactions | +2,915 | +298,136 B | +338 `PerformanceMeasure`; +2 `FiberNode`; +3 `HTMLDivElement` |

The chat delta is dominated by React development User Timing data:
`PerformanceMeasure` alone contributes 2,905,280 bytes. This evidence does not
support a production detached-DOM leak. It does show live chat-history growth,
and the endpoint DOM counter confirms that the rendered history remains
unbounded.

The leave pair grew by 89,307 nodes and 25,290,202 bytes after forced GC. The
largest deltas are Excalidraw external strings, source-map data URLs, font data,
and compiled code. Failure screenshots show Excalidraw appearing after the
Board assertion had already timed out. This pair measures late development
module loading, not retained remote media from the departed Participant.

## Numbered pre-fix findings

### 1. Remote SFU reconciliation is wrong and retries stale work without a bound

Severity: correctness blocker and dominant load source.

`sdks/typescript/client/src/media/client.ts` associates returned remote tracks
with requests by array position even though each request already has a stable
`sessionId` and `trackName`. A reordered or partial response can attach the
wrong remote track. The poll then retries remote publication references every
second while its cursor remains behind, with no per-snapshot backoff or
suppression.

The observed result is 2,903 server errors, 19 failed microphone cycles, and
failed camera and screen-share behavior. Correct identity matching and bounded
retry behavior must land first because this storm distorts every later CPU,
heap, and rendering measurement.

### 2. Leave disposes the client that the visible re-entry action tries to reuse

Severity: correctness blocker.

The LocalSpace leave lifecycle calls both `leave()` and `dispose()` and finishes
the access resource. The rendered `Try again` action then calls `join()` on that
disposed client, so re-entry cannot succeed. Ordinary Participant leave needs
to preserve or reacquire a usable arrival resource; final unmount and Episode
end still need full cleanup.

### 3. Native attachment staging confuses `File` with the SDK byte-input type

Severity: correctness blocker.

Both chat panels use a property-presence check that sees the inherited
`Blob.bytes` method on a native `File`. The code then follows the SDK byte-input
branch and fails before the attachment can be sent. One shared discriminator
must identify native `File` first and keep the two panel variants consistent.

### 4. The Board control does not receive its open state

Severity: correctness blocker with deferred-load cost.

SpaceView and ClassicSpaceView do not pass `whiteboard.isOpen` into their
ControlBars, so the Board control remains `aria-pressed="false"` after the
action. Excalidraw eventually appeared only after the 120-second assertion.
The product build confirms that Board code is already dynamic, but its lazy
dependency fan-out is large: `prod` is 1,106.91 kB raw and 353.77 kB gzip, and
the largest supporting client chunk is 1,821.04 kB raw and 744.22 kB gzip.

### 5. Chat does avoidable work and keeps the complete loaded history rendered

Severity: confirmed CPU and rendering cost; memory risk needs an after-fix run.

Each message render creates a new `Intl.DateTimeFormat`, which is the largest
named Chalk frame in both chat-active CPU profiles. Every scroll event also
calls `getBoundingClientRect()` for the viewport and each message marker with
no animation-frame coalescing. The complete loaded history remains in the DOM.

The CPU profiles, trace delta, and endpoint DOM growth all confirm the cost.
The forced-GC snapshots do not confirm detached DOM. The first correction is
to reuse the formatter and coalesce visibility reads. History virtualization
should follow only if the corrected long run still shows unacceptable live DOM
growth.

### 6. Stage updates defeat tile memoization and animate layout dimensions

Severity: high-confidence static cause with runtime layout evidence.

Stage creates fresh style objects and click callbacks inside the tile map, and
upstream Participant projections are also recreated. These inputs prevent the
memoized tile from bailing out. The transition animates width and height, which
forces layout rather than using a transform-only visual transition.

The non-chat pages record 3,172 to 3,222 layouts per minute, so there is a real
rendering problem. The current traces do not include React render counts and
cannot assign all of that work to Stage. The correction needs stable tile data
and handlers plus transform-only motion, followed by the same trace windows.

### 7. Speaking and reaction effects repaint expensive surfaces

Severity: confirmed visual-effect cost; the speaking halo needs an isolated
after-fix trace.

The speaking halo continuously animates `box-shadow`, a paint property, for
each speaking tile. The reaction trace already doubles Raster count and raises
GPU-task count by 47% against idle. That trace does not isolate the speaking
halo, so it cannot attribute the reaction delta to the halo. The correction
should use opacity and transform on a bounded pseudo-element and then compare
camera, hand, reaction, and idle windows.

### 8. AudioOutput rebuilds media effects from unstable arrays and callbacks

Severity: static churn source.

AudioOutput constructs new remote-audio arrays on each render, so dependent
effects detach and rebuild even when the underlying remote tracks did not
change. One fallback callback is also recreated. Stable derived inputs should
stop the effect churn; the corrected run must show whether it affects listener
and renderer counters.

### 9. Entrance-device selection mutates state during render

Severity: React correctness warning; exact warning path remains unproved.

SpacePage calls `selectEntranceDevices` inside a render-time memo. That is a
side effect and can trigger a cross-component update warning when device IDs
are present. The recorded path had empty device IDs, so this static defect is
not claimed as the exact source of the observed pre-mount warning. Move the
selection into an effect and retain a focused regression test.

### 10. The production Space route and deferred Board dependency need budgets

Severity: delivery and startup risk.

The frozen production build emits a 993.97 kB raw, 254.54 kB gzip Space route.
Board remains lazy, which keeps its largest dependencies off the initial route,
but those dependencies explain the large late development heap delta and make
the first Board open sensitive to load and compilation work. Bundle budgets
should cover both the initial Space route and the deferred Board entry.

The frozen source archive had no `.git` directory, while Vite requires
`git rev-parse HEAD`. The build used an empty local metadata commit only; the
build log records `bde30e42` as the measured product revision. No product file
changed before bundling.

## Correction order and rerun contract

Corrections proceed in numbered groups so evidence stays causal:

1. Fix SFU response identity and bounded retry behavior, then require a strict
   four-Participant shakedown with no 5xx storm.
2. Fix camera disable, attachment staging, re-entry, and Board state, rerunning
   the complete feature matrix after each correction.
3. Fix chat formatting and scroll work, then compare the chat trace and
   forced-GC panel pairs.
4. Stabilize Stage and AudioOutput inputs and replace layout or paint
   animations, then compare idle, camera, hand, and reaction traces.
5. Run the final 30-minute profile, focused traces, and forced-GC snapshots with
   the same cadence and Participant count. A performance claim is accepted only
   when the feature assertions also pass.
