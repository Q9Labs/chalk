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
- [ ] Local stack up on alternate ports (broker requirement bypassed).
- [ ] Harness shakedown run (2–3 min).
- [ ] Full 30–45 min profiling run.
- [ ] Prioritized findings report with numbers.
- [ ] Fix top items one at a time + before/after verification.

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
