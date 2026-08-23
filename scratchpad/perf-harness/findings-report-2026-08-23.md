# Chalk web app — memory/CPU/GPU profiling report (2026-08-23)

Harness: Playwright + CDP, 4 headless participants (fake media), 30-minute
scripted meeting against the local stack (Go API + Elixir sync + Vite web,
ports 18080/4100/13070). Scenario cycled mic/camera toggles, hand raise,
screen share, layouts (spotlight/grid/presentation), chat send/scroll/upload,
panel open/close, reactions, whiteboard draw/pan/zoom, and two leave/rejoin
cycles for P4. Samples every 5s; windowed timeline traces per feature;
heap snapshots at join/leave/panel beats; whole-run + windowed CPU profiles.

Run artifacts: `.private/chalk-perf/runs/2026-08-23T13-52-17-234Z/`
(re-run with `node scratchpad/perf-harness/run.mjs --minutes 30 --participants 4`).

Caveat on the environment: the app was profiled in `vite dev` mode (React dev
builds). React-dev-only overheads are marked **[dev]**; everything else
(layout/paint/CSS behavior, DOM growth, listener growth, Effect store churn)
behaves the same in production.

## Headline numbers (30 min, 4 participants)

| Signal | Value |
|---|---|
| Host DOM nodes | 548 → **29,100** (linear, chat-driven) |
| Host event listeners | 385 → **2,400** (+~1 per chat message) |
| JS heap (worst page) | 88MB → **484MB** (Casey); others 178–226MB |
| Retained `PerformanceMeasure` objects | 939 → **170,805** **[dev]** (= ~1.6 component renders/s sustained) |
| Retained Effect `Context/scope` objects | **≈500,000** across six scope sites |
| Paints/sec during reaction burst | **300–460/s** (should be ≤60) |
| Layout events/sec during screen share idle video | **83–182/s** |
| Style recalc/sec during whiteboard draw | 90–224/s |
| GC time (whole-run, P1) | 22.8s (1.2%) |
| Top JS self-time entry (non-idle) | `modifyOwnPropertyDescriptors` (Effect runtime) **18.5s**; `make$11` (Effect) 5.5s |

## Prioritized findings

### P1 — Stage re-render storm defeats tile memoization (CPU, all calls)
`sdks/typescript/react/src/components/stage/Stage.tsx:162-170` — `frameStyle(...)`
builds a fresh style object and fresh `click`/`doubleClick` closures inside the
tile map, so `React.memo` on `ParticipantTile` (participant-tile/ParticipantTile.tsx:53)
never bails. Every Stage render — active-speaker flip, roster delta, resize —
re-renders every tile including its `<video>` subtree reconciliation.
Runtime evidence: 170k component renders in 30 min on the host page **[dev
count, prod renders are fewer but the memo-bypass is identical]**; layout
storms of 83–182 Layout events/s while nothing but idle fake video plays
(share windows). Also `Stage.tsx:44` animates `width`/`height` (layout props)
in the stage `TRANSITION`, forcing layout during every 300ms transition.

### P2 — Chat: unvirtualized DOM + per-scroll-event layout reads (memory + CPU)
`ChatPanel.tsx:249-302` / `ClassicChatPanel.tsx:229+` render every loaded
message; DOM grows linearly (548 → 29,100 nodes in 30 min; ~6,400 retained
`HTMLDivElement`s in the final snapshot) and never shrinks.
`chat-panel-model.ts:35-43` (wired `ChatPanel.tsx:194-205`) runs
`getBoundingClientRect()` on the scroller plus every `[data-chat-sequence]`
node on **every scroll event** — N+1 forced layouts per wheel tick, with no
rAF batching. Listeners grow ~1 per message (385 → 2,400).

### P3 — Speaking-halo animation repaints every frame per speaking tile (GPU)
`packages/ui/src/styles/index.css:1432-1435` — `.chalk-voice-halo` animates
`box-shadow` spread 6px→14px infinitely (`chalk-voice-halo-breathe`,
:1392-1401). Box-shadow is non-composited: every frame is a full tile repaint,
scaling with speaking-participant count. Reaction rise (:1617-1649) is clean by
comparison (one-shot, translate3d). Paint evidence: 300–460 Paint events/s
during reaction windows on a mostly static UI.

### P4 — Effect store churn on the hot path (CPU)
Effect 4β runtime chunk (`Ref-LZ4OQgDS.js`) is the top JS self-time consumer:
`modifyOwnPropertyDescriptors` 18.5s + `make$11` 5.5s + anonymous 6.3s over
30 min, and ≈500k retained `system/Context/scope` objects in the final
snapshot. The store publishes (`SpaceStore.update*` → Effect SubscriptionRef)
run this machinery on every slice update; with per-frame state flips
(speaking detection) this multiplies the P1 storm. Structural fix is larger;
recorded here as the measured baseline.

### P5 — AudioOutput effect churn (CPU, low-med)
`AudioOutput.tsx:84,96` — `remoteWithAudio`/`remoteWithScreenShareAudio` are
new arrays every render, so the three effects at :220/:270/:319 tear down and
rebuild after every render of the component. Not a leak; churn proportional
to remote count × parent render rate (which P1 inflates).

### P6 — Background-tab polling continues (CPU, low)
`client/src/media/client.ts:529-541` — remote-publication poll keeps running
when the tab is hidden. One network poll per interval per hidden tab.

### P7 — Dev-only amplifiers **[dev]**
- React dev build emits a retained `performance.measure` per component render
  (`react-dom_client.js`, 9 call sites) — 170k objects/30 min, each pinning
  its fiber. Inflates dev-mode heap; invisible in prod builds.
- `logComponentRender`/`logRenderPhase` add per-render CPU in dev profiles.

### Verified clean (do not chase)
Media-track lifecycle (capture, toggle-off, leave paths all stop tracks and
clear `srcObject`), observer pairing (all ResizeObservers disconnect), reaction
expiry fibers (capped, deduped), whiteboard collab engine disposal, pagehide
release, dialogs' escape/click-outside pairing.

## Fix order (one at a time, harness-verified)
1. P1 Stage memo bypass (stable frame styles + handlers; transition to transform-only).
2. P2 chat scroll rAF batching + rect caching (keep unvirtualized DOM as follow-up).
3. P3 voice halo → composited transform/opacity ring.
4. P5 AudioOutput memoized arrays.
5. P6 visibility-gated poll.

Each fix: re-run `run.mjs --minutes 10 --participants 4`, compare the matching
windowed traces (layouts/s, paints/s) and metric trends against this baseline.
