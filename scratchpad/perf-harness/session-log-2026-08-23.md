# Web app perf profiling harness — session log 2026-08-23

Goal: profile apps/web + packages for memory/CPU/GPU inefficiencies across the
whole meeting experience; harness first, report before fixes.

Worktree: `.worktrees/perf-profile` (branch `perf/profile-meeting`).

## Environment findings

- `pnpm dev` (supervised stack) is broken on HEAD: `scripts/dev/chalk.mjs`
  `discoverBrokerRuntime` requires an untracked broker `wrangler.toml`, but the
  broker Worker sources were deleted from the repo in dc8f4a7a (2026-08-20).
  The web app itself no longer needs a Worker broker — access grants come from
  the API directly (`apps/web/src/lib/chalk-access.ts`), and vite proxies
  `/v1` to the local API.
- Workaround: `scratchpad/perf-harness/dev-stack.mjs` starts only what the
  meeting needs: postgres/redis containers, goose migrations, Go API
  (+ provider bridge, mTLS material mirrored from chalk-resources.mjs),
  Elixir sync, Vite web. Ports: api 18080, sync 4100, web 13070.
  SFU creds resolve from 1Password ("Cloudflare Realtime SFU chalk-local-dev").
- Join flow needs no login: open `/space?name=<n>`, app creates a public Space,
  address bar becomes `/space/<slug>#spaceInviteToken=cspi1.…`; replay that URL
  for other participants (pattern from scripts/dev/media-smoke-runner.mjs).

## Harness

- `scratchpad/perf-harness/dev-stack.mjs` — local stack orchestrator.
- `scratchpad/perf-harness/collectors.mjs` — CDP: 5s page metrics
  (nodes/listeners/documents/heaps/layout+style counts + durations), sampling
  CPU profiles (5ms whole-run on P1, 1ms windows on P2), streamed heap
  snapshots + structural summaries (top constructors by self size), windowed
  devtools.timeline traces (Paint/CompositeLayers/ImageDecode/Raster counts).
- `scratchpad/perf-harness/scenario.mjs` — feature steps from the real
  selector catalog (entrance → toolbar toggles → panels → chat/upload →
  layouts → reactions → screen share → whiteboard draw/pan/zoom → leave).
- `scratchpad/perf-harness/run.mjs` — orchestration; outputs under
  `.private/chalk-perf/runs/<ts>/`.

## Progress

- [x] Worktree created; deps installed.
- [x] Feature map (explore agent) + static anti-pattern scan (explore agent).
- [x] Local stack up on alternate ports (broker requirement bypassed).
- [x] Harness shakedown runs; all scenario features verified working.
- [x] Full 30-min profiling run (runs/2026-08-23T13-52-17-234Z).
- [x] Prioritized findings report (findings-report-2026-08-23.md).
- [ ] Fixes one at a time + before/after verification.

## Fixes applied (pending verification run)

1. Stage.tsx — memoized stylesById/handlersById so ParticipantTile/StageContentTile
   memo can bail; `animate` hoisted above hooks.
2. packages/ui styles — voice halo box-shadow animation → composited
   transform/opacity on a ::before ring (reduced-motion override updated).
3. ChatPanel/ClassicChatPanel + chat-panel-model — shared `createChatScrollWork`:
   rAF-coalesced scroll handling instead of N+1 getBoundingClientRect per event.
4. AudioOutput.tsx — remoteWithAudio/remoteWithScreenShareAudio memoized.
5. client/src/media/client.ts — remote-publication poll skips network while
   document.hidden.

## Baseline (30-min run) for comparison

- reactions windows: paints 200-463/s, layouts 73-224/s
- screenshare windows: paints 90-445/s, layouts 43-182/s
- host DOM 548→29,100; host listeners 385→2,400; worst heap 484MB
- 170k retained PerformanceMeasure (React dev) / ~500k Effect contexts

## Static scan highlights (to be confirmed by runtime numbers)

1. Chat scroll handler N+1 getBoundingClientRect per scroll event
   (chat-panel-model.ts:35-43) — high for long chats.
2. Stage.tsx frameStyle fresh objects/closures defeat ParticipantTile memo
   (:162-170) — re-render storm during speaker flips.
3. `.chalk-voice-halo` infinite box-shadow animation, non-composited, per
   speaking tile (packages/ui/src/styles/index.css:1432) — GPU/paint cost.
4. Chat list not virtualized (DOM grows with loaded window).
5. AudioOutput arrays recreated each render → 3 effects rebuild every render.
6. media/client.ts remote-publication poll ignores tab visibility.

## 18:44 shakedown completed

- A four-Participant, three-minute run completed and produced 239 metric rows,
  nine heap snapshots, one whole-run CPU profile, five timeline traces, and a
  terminal run manifest.
- The run was not a valid baseline. Four of 90 feature steps failed:
  whiteboard draw and pan/zoom never reached Excalidraw, the second-round
  Presentation selection did not resolve, and the attachment composer was
  disabled when the harness tried to send.
- The live whiteboard probe found the cause of the first failure: the floating
  controls must be revealed with a real pointer move. Clicking the visible
  Board control opened Excalidraw within two seconds and exposed two canvases.
  The old helper dispatched a click to a zero-size duplicate control.
- The existing harness also treats clicks as success without proving their
  state changes, lets asynchronous samplers overlap, and has no fatal cleanup
  path. Its output is useful shakedown evidence only.

## 18:48 environment and harness decision

- The Chrome plugin could not connect to Helium because its browser bridge
  rejected the available automation service as untrusted. The required
  Playwright harness remains usable; the final visible Helium pass is still
  unproved.
- The canonical `pnpm dev` path is still broken after the unified public-invite
  change: `scripts/dev/chalk.mjs` requires a local broker config that the same
  change deleted. The temporary supervisor is sufficient for instrumentation
  work but does not satisfy the final canonical-stack requirement.
- The durable harness will live under
  `scripts/performance/space-experience/`. It will require real visible actions,
  state assertions, serialized sampling, paired heap diffs, synchronized trace
  windows, a terminal manifest, and run-to-run comparison before any product
  performance change is made.

## 20:17 strict-baseline correction

- The earlier checked progress, 30-minute baseline claim, numbered baseline,
  and “fixes applied” section are not accepted evidence. They appeared while
  another agent was editing the profiling worktree, and the cited run did not
  enforce postconditions. The product edits remain uncommitted and have not
  been used for a pre-fix comparison.
- A clean detached worktree at temporary commit `06fe1152` now contains the
  pre-fix source plus only the profiling tooling. It uses the isolated
  `chalk_perf_profile` database, so shared development state cannot bias or
  wedge the run.
- Strict shakedown
  `shakedown-2026-08-23T15-10-19-227Z-x6c76a` joined four Participants and
  collected the scheduled metrics and heap snapshots, but failed 16 feature
  steps. Its results are invalid for performance conclusions. The primary
  harness defect is browser-wide Chromium tracing being started once per page;
  selector cleanup, chat pacing, attachment verification, and leave/rejoin
  postconditions also need correction before the real baseline.

## 21:02 integrated-harness shakedown

- Temporary commit `50e7c5c4` keeps application, package, and SDK files
  byte-for-byte equal to pre-fix base `bde30e42` while overlaying the integrated
  profiler. The stack uses isolated Postgres and RustFS resources; the RustFS
  startup check proved CORS plus real PUT and GET operations.
- Hardware validation proved ANGLE Metal on the Apple M4 with GPU compositing
  enabled. Software rendering now fails closed before workload execution.
- Strict run `shakedown-2026-08-23T15-53-05-885Z-0f2wcr` is also invalid. Its
  camera action timed out and the 10-second `Tracing.tracingComplete` deadline
  expired, leaving Chromium tracing active. Later trace starts failed as a
  cascade, so the run was stopped early and cannot support product findings.
- A concurrent commit placed combined product changes on the profiling branch.
  They remain outside the detached pre-fix tree and are not accepted as fixes
  until a valid baseline exists and each change is measured independently.

## 21:41 lifecycle-complete shakedown

- Strict run `shakedown-2026-08-23T16-25-36-436Z-gc5noj` proved the bounded
  `ReturnAsStream` trace lifecycle across idle, reaction, hand, camera, screen
  share, and chat-scroll windows. It remained invalid because five real feature
  steps failed, but later traces did not cascade after the first failure.
- The native chat attachment flow exposed a product bug: Chromium `File`
  objects now inherit `Blob.bytes()`, so both chat surfaces misclassify them as
  Chalk raw-file values and reject the file before staging. The harness keeps
  the real chooser path so the pre-fix report records this missing surface.
- The whiteboard appeared in the final failure screenshot after its 30-second
  assertion expired. Sync also logged PostgreSQL checkout timeouts while four
  eager whiteboard subscriptions were active, so the next run distinguishes a
  delayed backend-ready state from a missing canvas and allows 120 seconds for
  the cold path.
- Blake's CPU profile covered only the 15 seconds after re-entry because the
  old harness navigated the page and reset its V8 profiler. Temporary commit
  `2b1bcbb9` starts profiles after initial navigation, uses the visible
  `Try again` path without navigation, and fails closed below 95 percent
  cross-Participant duration coverage. Product source remains byte-for-byte at
  pre-fix base `bde30e42`.

## 21:56 measurement-pass split

- Strict run `shakedown-2026-08-23T16-42-19-863Z-sjti1x` confirmed the profiler
  fix: all four CPU profiles covered 633.5–633.8 seconds, for 99.94 percent
  minimum duration coverage across Participants.
- The run remains invalid for frontend performance conclusions. Camera disable
  and screen-share publication still failed after five-second quiet windows;
  chat file staging returned `undefined is not a supported chat attachment`;
  and Board activation reverted to `aria-pressed=false` with no loading state,
  alert, or canvas after 120 seconds.
- Immediate parsing of roughly 154 MB heap snapshots coincided with PostgreSQL
  handshake failures, hundreds of HTTP 503 responses, and failed re-entry. The
  durable harness is therefore splitting the live CPU/metrics/trace run from a
  separate heap-snapshot pass, and will parse heap files only after Chromium is
  closed. This prevents measurement tooling from creating the backend failure
  it is supposed to observe.

## 22:22 clean-stack shakedown and host-contention rejection

- No-snapshot run `shakedown-2026-08-23T17-03-31-741Z-bp8jaj` completed 438
  seconds of four-Participant CPU coverage at a 99.89 percent minimum duration
  ratio. PostgreSQL and Sync stayed healthy, which separated product failures
  from the earlier heap-snapshot pressure.
- The run proved a sustained client retry storm: three observers recorded 536
  failed remote SFU pulls over roughly 320 seconds. Camera disable, remote
  screen share, native chat upload, whiteboard activation, and same-page
  re-entry also failed strict postconditions. Ordinary chat, panels, layouts,
  pinning, reactions, hand raise, microphone, leave, and roster checks passed.
- Runtime shakedown `shakedown-2026-08-23T17-17-59-086Z-5e8fgz` was stopped and
  excluded from CPU conclusions when unrelated host work drove load average to
  57 and inflated trace drains. The artifact remains marked running because the
  PTY interrupt terminated Node before its normal finalizer completed.
- Raw browser traces were valid, but the analyzer still read the obsolete
  per-page event shape and emitted empty event counts. Analysis now delegates
  to the browser-wide trace summarizer, with a focused regression test.

## 22:34 remote pre-fix isolation

- The local host never reached the quietness gate: unrelated jobs remained
  active while load average ranged from roughly 9 to 24. The local stack and
  quietness monitor were stopped, so no further CPU evidence will use that
  contaminated host.
- Detached commit `18b8d42a` still matches pre-fix product base `bde30e42`
  byte-for-byte. The stack launcher now accepts unique profiler database,
  PostgreSQL, and Redis resources and can receive the same development SFU
  credentials through its process environment without writing them to disk.
- The frozen tree is installing under a unique private directory on the quiet
  `agents-macmini` testing host. That host has hardware Metal support, Podman,
  native build tools, and no Chalk services on the profiler ports.

## 22:50 remote shakedown and re-entry coverage correction

- Remote run `shakedown-2026-08-23T17-43-08-119Z-xffrdj` captured all four CPU
  profiles for 269.1–269.7 seconds, a 99.78 percent minimum coverage ratio,
  with ANGLE Metal on Apple M4 and no metric sampling errors. It reproduced
  camera-disable, screen-share, native chat upload, and Board failures plus
  399 HTTP 503 responses across the three observers in roughly 4.5 minutes.
- The run did not cover same-page re-entry: `leaveSpace()` completed without a
  return value, and `runLeaveRejoin()` treated that successful void result as a
  failed action. Temporary commit `c7c1a094` wraps successful Leave completion
  in an explicit result and adds a regression test for the complete Leave,
  roster, Try again, and roster-recovery sequence.
- Clean-host portability also exposed and corrected two launcher gaps before
  measurement: Sync dependencies are now prepared before supervision, and the
  API runs as a directly built child so stopping the supervisor cannot orphan
  a `go run` binary. The corrected shakedown is held until unrelated remote
  cleanup and macOS audio/indexing work return below the quiet-host threshold.

## Incident 2026-08-23 ~20:05 — dev-stack crash loop (port collision, resolved)

A second stack launch crash-looped (API exit ×5, sync exit ×5). Root cause was
not the script: the previous stack from the verification run was still up, so
the new API died on `bind: address already in use` for 127.0.0.1:8444, and the
new sync then failed its provider-bridge boot check against the OLD API with
`tls: unknown certificate authority` (fresh run's client cert vs old run's CA).
Restart budget exhausted; supervisor exited.

Resolution: all processes gone, ports 18080/8444/4100/13070 free, postgres and
redis containers still up. Next `node scratchpad/perf-harness/dev-stack.mjs --up`
starts clean (~1–2 min warm).

Follow-up candidates for whoever owns the script now (it was adapted to the
`chalk_perf_profile` database and is staged separately — deliberately left
untouched here):

- Ports are hardcoded; two simultaneous stacks will always collide. Consider
  `CHALK_DEV_API_PORT`/`CHALK_DEV_WEB_PORT`-style env overrides (vite + API
  already read them).
- Fail fast on bind conflict (probe ports before spawning, clear error) instead
  of burning the restart budget on EADDRINUSE.

## 23:35 corrected remote coverage and long baseline

- Corrected pre-fix run `shakedown-2026-08-23T18-19-07-923Z-vz6rb6` completed
  the full Leave path: remote Leave and exact roster contraction passed, then
  the visible `Try again` path failed its 90-second video-grid postcondition.
  All four CPU profiles covered 357.5–358.0 seconds at a 99.84 percent minimum
  ratio, and shared sampler drift stayed at or below five milliseconds.
- The run reproduced six strict product failures: remote camera disable,
  remote screen-share visibility, screen-share zoom and pan, native chat file
  staging, Board activation, and same-page re-entry. Three observers recorded
  395 HTTP 503 and 27 HTTP 500 responses. Waiting and Transcript were recorded
  as unreachable for this Space, and tile dragging as unsupported.
- The host remained shared at a 4.65–7.16 one-minute load on ten reported
  logical CPUs. Process-scoped CPU is useful as shape evidence, but absolute
  CPU comparisons from this short run are excluded. The required 30-minute
  pre-fix profile began as
  `profile-2026-08-23T18-26-19-285Z-999rzs`; it records host load beside every
  five-second drift row and has four exact roster joins with no stale profiler.
