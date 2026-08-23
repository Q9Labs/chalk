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
