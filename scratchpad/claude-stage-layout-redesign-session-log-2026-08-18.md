# Stage layout redesign — session log (2026-08-18)

## Context
Hasan: participant tile layout/rendering in the Space stage is broken; brainstorm → redesign → implement.
Discovery by Luna explorers: `scratchpad/codex-stage-layout-code-map-2026-08-18.md`, `scratchpad/codex-stage-layout-issues-and-intent-2026-08-18.md`.

## Root causes found
- Count→Tailwind class table, no container measurement (crop / wrong aspect, col-span hacks).
- Separate React trees per layout mode and per stage state (share / whiteboard / grid) → `<video>` remounts, black flashes.
- 3× duplication (Classic/Chalk grid, tile media code, RN aside).
- Pin / active speaker inert: `isSpeaking` never populated although sync presence exists.
- Overflow "+N more" at 26 tiles; count-only mobile branch; muted track shows frozen frame; no local mirror.

## Decisions (Hasan)
- Overflow: pages everywhere (desktop + mobile), `maxVisibleParticipants` = tiles per page. "+N more" removed.
- Speaker source: sync presence projected into client `Participant.presence`.
- Stage model: everything is a stage item — participants, screen shares (one per sharer), whiteboard. Any item pinnable / primary.
  Spotlight = one primary + strip; grid = equal tiles. Unfocused content tiles look like participant tiles ("Nora's screen", "Board" card).
  Primary priority: pinned → newest screen share → whiteboard if open → active speaker → last speaker → first remote → local.
  `focus` / `presentation` stay public layout values (same renderer; presentation = content-first).
- Mobile: design + document only, no implementation this pass.
- Future (not built): split / two-primary mode; drawer redesign for side panels (phase 2).

## Architecture
- `stage-layout.ts` pure fitter: (w, h, count, mode) → absolute frames; best-fit column search for 16:9, adaptive aspect on portrait, centred last row, pages.
- `stage-order.ts` pure ordering: primary priority, sticky visible set, page slicing.
- `useVideoTrack` shared hook (attach/detach, srcObject cleanup, mute/unmute/ended → avatar, mirror local).
- `Stage.tsx` single renderer, both skins; flat item list, transforms + 300 ms transitions, one ResizeObserver, no remounts across mode / page.
- `ParticipantGrid` becomes a thin public wrapper; `SpaceView`/`ClassicSpaceView` stop swapping trees.

## Delegation
- Codex Luna lane "client presence" launched 13:28 (bridge 1787059690901-3721fd9c) — adds `Participant.presence`, equality, tests, literal updates. Report: `scratchpad/codex-client-presence-lane-2026-08-18.md`.

## Implementation (done)
- `components/stage/`: `stage-layout.ts` (fitter, 26 tests), `stage-items.ts` (items, stable order, primary choice, 7 tests), `Stage.tsx` (single renderer, 7 tests), `StagePager.tsx`, `StageContentTile.tsx`.
- `participant-tile/`: `useVideoTrack`, `TileShell`, `ParticipantTile` (skin-adaptive; `connectionQuality` 0 = unknown).
- `participant-grid/ParticipantGrid.tsx` is a thin wrapper over `Stage`; `ClassicParticipantGrid` deleted.
- `space-view/SpaceStage.tsx` binds SpaceView tiles + whiteboard to the stage (screen share primary → `ScreenShareViewSurface`, whiteboard primary → `WhiteboardView`).
- `space-view/useContentLayoutSwitch.ts`: flip to `presentation` once when content appears, restore the previous layout when it goes; header shows the real layout.
- `selectors/space-selectors.ts`: `isSpeaking` / `isActiveSpeaker` from sync presence; `isVideoEnabled` = camera only.
- Test helper `test-support/fake-media-track.ts` (EventTarget-backed fake track).
- Public exports: `Stage`, `StageProps`, `buildStageItems`, `StageItem`, `StageLayout`.

## Verification
- react: `check-types` clean, vitest 88 files / 231 tests green, oxfmt clean. `check:tokens` still fails on pre-existing Classic*/ChalkEmptyState/Input/Textarea files (not mine).
- apps/web sdk-preview: 41 tests green; `tsc` only the pre-existing `chalk-access.test.ts` error.
- Playwright shots in `/tmp/chalk-stage-2026-08-18/shots/` (grid 5/12, focus 9, presentation 5 + chat, grid with unfocused share tile, classic 9, mobile pair).

## Bugs found by the screenshots
- Stage rendered 0×0: the flex `<section aria-label="Space stage">` had no `flex-1` and `ChalkPanel`'s content wrapper no height, so an absolutely positioned stage collapsed. Fixed in SpaceView / ClassicSpaceView (`flex-1`, `contentClassName="h-full min-h-0"`).
- Bottom tile row sat under the floating control bar → stage container now reserves `pb-20 md:pb-24`.
- Pager overlapped the strip → `Stage` refits with a 40 px `PAGER_BAND` whenever there is more than one page (a shorter box never fits more per page, so paging stays on).
- Preview: `stage=share` was a DOM overlay covering the stage; replaced by `preview-screen-track.ts` (canvas `captureStream`) fed into `media.remote`, owned by an effect (StrictMode double-mount stopped a memo-owned track). `ScreenShareMock` deleted. Roster counts 9 and 12 added; share no longer forces `presentation` (the switch hook does it).
- Preview `stage=whiteboard` still uses the overlay mock — WhiteboardView needs a real client; note for later.

## Mobile notes (deferred, not implemented)
- Portrait fitter: today the same column search runs on a 390 px box; grid gives 2 columns of tall 3:4-ish tiles (fine), but focus/presentation strip fits one tile per page (8 pages for 9 people). Wanted: dominant tile + horizontal filmstrip with 2.5 tiles visible and touch swipe (mockup 06), min tile height ~96 px, hide the arrow buttons and keep the dots.
- Compact control bar is `hidden md:block`-swapped; reserve `pb-20` currently — should be measured from the actual bar height (ResizeObserver on the bar) once the bar redesign lands.
- Split / two-primary mode (share + whiteboard side by side): fitter can take a `primaryIds: [a, b]` and split the primary area 50/50 landscape, stacked portrait; not built.

## Staged (not committed)

Staged 45 paths with only my hunks: stage/, participant-tile/, participant-grid/, SpaceStage + useContentLayoutSwitch, my SpaceView/ClassicSpaceView/SpaceView.test hunks (other agent's Episode-duration and dock-button hunks left unstaged), selectors, bindings test, fake-media-track, components index, apps/web sdk-preview (+ ScreenShareMock removal), the client presence lane (types, index, participants-controller, parity helpers, RN and mobile presence fixtures), the two CHANGELOG bullets, and this log. `scratchpad/.stage-shot.mjs` stays untracked scratch.

## Phase 2 — right-hand drawer (done, staged, not committed)

Hasan: the chat/participants/etc. panels were "too short" and did not feel integrated; wanted a proper drawer from the right.

- Root cause of "too short": the old `<aside>` sat inside the padded stage row (`top-20 bottom-24`), and `ChalkPanel`'s content wrapper has no height, so chat/transcript columns never filled the panel.
- New `space-view/SpaceDrawer.tsx` + `useDrawerPresence.ts` (+ tests). Behaviour: ≥1024 px a 380 px column docked right of the stage that pushes the stage (width keyframes so the stage shrinks in step); below that a fixed sheet `min(100%, 420px)` over a scrim. Presence hook retains the last panel through a 200 ms exit (0 under reduced motion). Escape closes; focus moves into the drawer on open and back to the opener on close. Drawer is a plain focusable div so panels keep their `role="complementary"` landmarks.
- CSS in `packages/ui/src/styles/index.css`: `.chalk-drawer`, `.chalk-drawer-content`, `.chalk-drawer-scrim`, keyframes `chalk-drawer-slide-out|grow|shrink`.
- SpaceView / ClassicSpaceView: body row is now `stage column (padding + control bar) | drawer`; the `lg:grid-cols-[1fr_340px]` aside is gone.
- Panels: removed the sidebar variants' own slide-in (chat, participants, transcript, both settings) so they don't double-animate inside the drawer; `contentClassName="flex h-full min-h-0 flex-col"` on Chat/Transcript/Admission ChalkPanels and `min-h-0 flex-1` scroll areas so they fill the drawer; classic transcript content was `overflow-hidden` with an onScroll — now `overflow-y-auto`. Admission list dropped its `max-h-80` cap and `AdmissionPanel` gained `onClose` + close button in both skins.
- Not in the drawer: turnkey Settings is a dialog (`dialog=settings` preview), unchanged.

Verification: react `check-types` clean, vitest 89 files / 238 tests, apps/web sdk-preview 41 tests. Classic + chalk shots (chat, people, transcript, admission at 1440; sheet at 900 and 390) in `/tmp/chalk-drawer-2026-08-18/after-*.png`, befores in `before-*.png`.

Staged with only my hunks (SpaceView/ClassicSpaceView/SpaceView.test/CHANGELOG re-staged from filtered content, other agent's Episode-duration/dock-button hunks left unstaged).

## Phase 3 — fill the stage + tile chip (done, staged, not committed)

Hasan (classic skin shots of 2/9/12 grids): empty bands around the grid; wanted the space "fully taken", smart resizing if needed. Also wanted the bottom-left name rectangle redone ("liked the previous one much more").

- `stage-layout.ts`: grid tiles now take their whole cell. `bestArrangement(box, count, options)` tries every column count, gives the tile the full cell, and only clamps when the cell aspect leaves `[minAspect 3/4, maxAspect 21/9]`; clamped arrangements are scored at 0.85× so a filling 2+1 beats three tall clamped tiles. `minTileHeight: 120` joined the options so phone pages don't get 70 px tiles; the aspect list (`aspectsForBox`, `LANDSCAPE_ASPECTS`, `PORTRAIT_ASPECTS`, `ASPECT_SWITCH_GAIN`, `aspects` option) is gone. Single tile and spotlight primary already filled. Last row still centres, so 5 = 3+2 leaves the bottom corners open by design.
- `Stage.tsx`: passes `{ ...DEFAULT_GRID_OPTIONS, maxPerPage, minTileWidth }`.
- Tile chip: `TileShell` renders classic as one dark glass pill (`rgba(12,14,18,.62)` + blur + `ring-white/10`), chalk as a `ChalkPanel` with the same inner row (`min-w-0` so the name truncates to the tile instead of a 120 px cap). `ParticipantTile` chip content: xs avatar (only when the video is off), 13 px white name with a muted "(You)", then plain marks — red mic-off (`--chalk-app-danger`), yellow raised-hand disc (`--chalk-yellow`, bounces), white share icon; the coloured `ChalkBadge` circles are gone.

Verification: react `check-types` clean, vitest 91 files / 246 tests, apps/web sdk-preview 41 tests. Classic shots at 1440 (2/3/5/9/12 grid, 9+chat drawer, focus 9), phone 390 (5) in `/tmp/chalk-stage-2026-08-18/fill-*.png`, chip close-ups `chip-*.png`.

## Phase 4 — ghost header, presence, sounds, reactions, preview parity (done, staged, not committed)

Hasan (three classic shots, then one focus+People shot mid-turn): preview not "fully decked out" vs /space; presence/active-speaker UI old; slimmer/ghost header, stage further down, floating control bar; sounds unwired; reactions picker + emojis poor; Info next to Settings, participants button out of the header, layout controls redesigned (not pills); pager arrows congested and dots too bold; tile corners clipped by the stage box; drawers not blending; chips too big on small tiles.

- Header (`ClassicSpaceHeader`, `SpaceHeader`): 56 px ghost bar, no invite button; right group = status badges, `LayoutMenu`, Info, Settings. New `space-header/LayoutMenu.tsx` on Base UI `Menu` (Spotlight / Grid / Presentation with descriptions, radio items). The popup portals into an out-of-flow `menuHost` div inside the header (so it inherits the skin theme without joining the flex row); Base UI names the popup after the trigger, so tests query `menu` by "Layout: Spotlight". Popup is `w-max` + `max-w` so descriptions do not wrap.
- Stage column: `px-3 pt-1 pb-14 md:pb-16`, control bar floats over the stage. `Stage.tsx`: `PAGER_BAND` 22, `p-1` inset on the clipping box (fixes clipped tile corners), pager gets `arrowsCenterY`/`dotsHeight`; `StagePager` rewritten as edge glass arrows centred on the strip plus small muted dots and sr-only live text.
- Presence: `TileShell` loses the `speaking` prop/ring and is a `@container`; chip and status marks scale at `@[240px]`. `ParticipantTile` shows `chalk-sound-bars` in the chip and a `chalk-voice-halo` around the xl avatar when speaking and unmuted. `.chalk-tile-speaking` removed from `packages/ui` CSS.
- Sounds: `internal/sound-cues.ts` (diff snapshots → cues, asset lookup, player), `useSoundCues(enabled)`; `Chalk` feature `sounds` (default on) → `SpaceView` / `ClassicSpaceView`; Settings dialogs gain a Sounds toggle. Vitest aliases `@q9labsai/chalk-ui/assets` to the ui source; tsup marks it external.
- Reactions: `composite/reaction-float.ts` + `ReactionTray` (compact tray above the bar), pickers/overlays reworked in both skins.
- Drawer: `--chalk-drawer-width: 396px`, docked content is an inset card (`inset: 4px 20px 16px 0`, radius 10) aligned with the stage. A 2 px dark line 4 px left of the open drawer was the unlayered apps/web `:focus-visible { outline: 2px solid var(--ink) }` beating every SDK utility on the programmatically focused drawer; `apps/web/src/styles/base.css` now wraps that rule in `@layer base` (verified by pixel scan).
- Preview parity: `SdkPreviewGallery` enables share, whiteboard, sounds, info, transcript, wires `onToggleWhiteboard`, and `preview-audio-track.ts` publishes one silent `AudioContext` destination track as a microphone publication for every unmuted remote (the react `isMuted` selector = no mic publication), so Nora's bars/halo render like live.
- Tests: header tests drive the menu (`mouseDown` + `click` in happy-dom); bindings tests look for `Layout: …` triggers; SpaceView test asserts the new drawer classes; `sound-cues.test.ts` (7).

Verification: react `check-types` clean, vitest 90 files / 253 tests, oxfmt run on all touched files; apps/web sdk-preview 41 tests, `tsc` only the pre-existing `chalk-access.test.ts` error. Classic shots in `/tmp/chalk-stage-2026-08-18/p4-*.png` (grid 9/12, focus 9, people drawer, layout menu both skins, reactions, phone, 900 px sheet, `p4-grid9-audio.png` for presence). Left alone: the other agent's `useEpisodeDuration` hunks (control bars, SpaceView, test) and unrelated CHANGELOG bullets.
