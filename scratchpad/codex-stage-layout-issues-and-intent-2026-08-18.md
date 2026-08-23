# Participant-tile stage: evidence, intent, and open questions

Inspection date: 2026-08-18. Scope was read-only discovery of the React SDK
stage, its web embedding, design references, issue logs, tests, and recent Git
history. The working tree was already dirty; no existing file was changed.
This report is evidence, not a redesign proposal.

## A. Intended stage behaviour

- `docs/design.md` is a descriptive snapshot last verified on 2026-08-02, not
  the implementation source of truth (`docs/design.md:1-9`). It is still the
  clearest written stage contract found in the repository.
- The design system says content owns the Space: video, shared screens,
  whiteboards, and conversation take available space; controls stay in
  reserved chrome and never cover Participant content (`docs/design.md:11-21`).
- The same principles require calm spacing and one-pixel structure, with Chalk
  colors carrying state rather than becoming decorative gradients
  (`docs/design.md:15-21`).
- Tiles use an 8px-to-10px radius and no shadow. Camera-off tiles use a pale
  Chalk wash with a flat centered avatar, with alternating participant washes
  to keep adjacent tiles distinct (`docs/design.md:238-241`).
- Active speaker is meant to receive space, not spectacle. Spotlight puts the
  active speaker on the large stage and keeps the remaining Participants in a
  stable filmstrip (`docs/design.md:242-244`).
- Poor connection, muted, and raised-hand states stay compact and attach to a
  corner or name tag; raised hand is smaller than the avatar and clear of the
  identity label (`docs/design.md:242-244`).
- Name tags belong at the lower-left of media tiles on a dark translucent
  surface, with white text and compact optional state icons. They must not grow
  tall enough to cover meaningful video (`docs/design.md:234-236`).
- Grid layout gives Participants equal weight. Spotlight uses the active or
  pinned Participant for the large stage. Sidebar layout reserves a narrow
  Participant column (`docs/design.md:322-324`).
- The live Space shell is centered to a 1440px maximum in the written design,
  with a 76px header, flexible stage/optional panel, and a reserved control row
  with safe-area padding (`docs/design.md:314-321`).
- The stage gap is 12px, with outer padding from 12px on mobile to 32px on
  desktop (`docs/design.md:322-323`).
- Opening Participants or Chat creates a 340px second column at desktop sizes;
  at narrow sizes the panel overlays the stage while preserving safe space above
  the dock (`docs/design.md:248-260`, `docs/design.md:322-324`).
- Whiteboard and screen share replace the main stage. They are not small
  floating cards over video (`docs/design.md:288-294`).
- A screen-share placeholder should look like real working software, with
  recognizable browser/document chrome, realistic hierarchy, and a small
  “shared by” label (`docs/design.md:288-294`).
- Mobile preserves the hierarchy instead of shrinking desktop UI. The live
  Space uses one dominant tile or a two-column grid, and Participants/Chat open
  as sheets or full-height panels (`docs/design.md:326-334`).
- Mobile docks may scroll only when every visible control retains a 44px target;
  microphone, camera, and Leave remain immediately reachable, with safe-area
  insets on headers, docks, composers, and sheets (`docs/design.md:332-334`).
- Motion is for state and spatial change, not decoration. Layout changes may run
  up to 300ms; layout-janking height animation, shimmer on loaded content,
  continuous floating, and repeated status pulsing are explicitly discouraged
  (`docs/design.md:336-347`).
- The accessibility contract requires tile identity and state to be exposed to
  assistive technology, no duplicate name reading, and no camera/microphone/
  connection state communicated by color alone (`docs/design.md:349-360`).
- The design board is the base-light visual reference for the system
  (`docs/design.md:1-9`). The written color tokens use warm paper, white
  surfaces, ink, muted metadata, and four semantic Chalk colors
  (`docs/design.md:23-64`).
- Large regions stay neutral; a tinted wash may identify one bounded tile or
  status surface. Gradients are prohibited on avatars, controls, cards, and
  panels (`docs/design.md:59-64`).
- The stage layer model places video/shared content at z-index 10, tile chrome
  at 20, the dock at 30, and panels at 40 (`docs/design.md:368-383`).
- The release checklist says content must have more space than chrome, controls
  must not obscure video/avatars/labels/shared content, side panels preserve the
  stage where space allows, and mobile composition must respect safe areas
  (`docs/design.md:387-400`).
- The React SDK vocabulary historically defined one Stage, grid/focus/
  presentation Layouts, ParticipantGrid, ParticipantTile, Filmstrip, and
  ScreenShareView as separate concepts (`scratchpad/history/2026-W28.md`).
- The 2026-08-01 redesign pass reframed the live room around a speaker-view
  stage, one horizontal filmstrip, one control dock, and a compact mobile grid
  (`scratchpad/history/2026-W31.md`).
- The same redesign log records a four-person horizontal filmstrip, reserved
  controls below the stage, and browser verification without tile/control
  overlap (`scratchpad/history/2026-W31.md`).
- The mobile mockup set is explicitly an implementation reference for the
  default Space stage and its progressive disclosures
  (`docs/redesign/mobile-sdk-mockups/INDEX.md:1-5`).
- Stage/Space mockup files under `docs/redesign/mobile-sdk-mockups/` are:
  `06-space-default-live-stage.png`, `07-space-more-actions-sheet.png`,
  `08-space-people-sheet.png`, `09-space-chat-sheet.png`,
  `10-space-board-sharing.png`, `11-space-participant-actions-popover.png`,
  and `12-space-settings-sheet.png` (`docs/redesign/mobile-sdk-mockups/INDEX.md:16-22`).
- Mockup 06 is described as a default live Space with a dominant Participant,
  stable filmstrip, quiet secure header, elapsed-time metadata, compact status
  indicators, and a reserved footer dock (`docs/redesign/mobile-sdk-mockups/INDEX.md:16`).
- The rendered `06-space-default-live-stage.png` shows one large upper tile
  for Nora Williams, two smaller lower tiles for Hasan and Akash, and the dock
  below the stage. The image is 853x1844; visual source:
  `docs/redesign/mobile-sdk-mockups/06-space-default-live-stage.png`.
- Mockup 10 makes Board the primary shared content while retaining a stable
  Participant filmstrip and reachable People, Chat, More, and Leave controls
  (`docs/redesign/mobile-sdk-mockups/INDEX.md:20`).
- The rendered `10-space-board-sharing.png` shows the shared Board as the large
  surface, two Participant tiles below it, a Board state control, and the
  reserved dock. Visual source:
  `docs/redesign/mobile-sdk-mockups/10-space-board-sharing.png`.
- The shared mobile mockup contract requires an edge-to-edge iPhone-class
  canvas, safe areas, reserved footer dock, 44px touch targets, flat
  deterministic initials avatars, and canonical product language
  (`docs/redesign/mobile-sdk-mockups/INDEX.md:24-35`).
- `product.yaml` marks Entrance, admission, role/capability handoff, and
  screen-share control semantics as implemented, with `apps/sync` and the SDK
  as evidence (`product.yaml:30-45`). It does not specify tile geometry.
- `CHANGELOG.md` records an explicit zero-Participant state for ParticipantGrid
  across desktop and mobile (`CHANGELOG.md:151-162`).
- `GLOSSARY.md` makes Space, Episode, and Participant canonical and bans legacy
  room/conference vocabulary (`GLOSSARY.md:266-278`, `GLOSSARY.md:308-320`).

## B. Evidence of breakage

1. **Mobile three- and four-Participant composition conflicts with the stage
   contract.**
   - Symptom: the documented mobile default is a dominant tile or two-column
     hierarchy, but the current mobile branch renders three or four Participants
     as an equal 2x2 grid (`sdks/typescript/react/src/components/participant-grid/ParticipantGrid.tsx:228-237`).
   - The 2026-08-04 mobile mockup set calls 06 the default live stage and its
     image shows one dominant tile plus a lower filmstrip, not four equal tiles
     (`docs/redesign/mobile-sdk-mockups/INDEX.md:3,16`, visual source listed in A).
   - Current status: still present in both the Chalk and Classic renderers;
     `ClassicParticipantGrid.tsx:193-202` has the same 2x2 branch. No geometry
     test asserts the intended dominant/filmstrip relationship.

2. **Mobile ignores the requested focus/presentation hierarchy.**
   - Symptom: `ParticipantGrid` enters the mobile count branches before the
     desktop `layout === "focus"` and `layout === "presentation"` branches;
     mobile 1/2/3-4/5+ behavior is selected only by count
     (`ParticipantGrid.tsx:199-302`).
   - `SpaceView` and `Chalk` default to `focus` (`SpaceView.tsx:135-145`,
     `Chalk.tsx:249-262`), so the live mobile default does not use the focus
     renderer that supplies a large participant and filmstrip.
   - Current status: still present. The mobile code comments explicitly call
     the 2x2 path the behavior for 3-4 Participants
     (`ParticipantGrid.tsx:228-237`).

3. **Pinned Participant is not authoritative in focus or presentation.**
   - Symptom: `pinnedParticipantId` only reorders the array by moving the pinned
     item to index zero (`ParticipantGrid.tsx:73-84`).
   - Focus chooses the first non-local speaking Participant, then the first
     non-local Participant, then the first item; it never checks the pinned ID
     (`ParticipantGrid.tsx:91`). Presentation chooses a screen sharer first and
     then calls the same helper (`ParticipantGrid.tsx:337-342`).
   - Only the default grid passes `pinned` to a tile for a ring
     (`ParticipantGrid.tsx:393-406`); focus and presentation do not pass it to
     their main or filmstrip tiles.
   - Current status: still present in `ClassicParticipantGrid.tsx:36-47,54,263-293`.
     There is no test for pinned selection or pinned-vs-active-speaker priority.

4. **The active-speaker rule is underspecified in code and excludes local
   speaker selection.**
   - Symptom: `getPrimaryParticipant` searches only non-local Participants for
     `isSpeaking`, then only non-local Participants, then falls back to the first
     item (`ParticipantGrid.tsx:91`).
   - A local Participant speaking alone therefore cannot become the focus main
     tile when a remote Participant exists; this conflicts with the written
     “active or pinned Participant” rule (`docs/design.md:242-244,322-324`).
   - Current status: still present in the duplicated Classic helper
     (`ClassicParticipantGrid.tsx:54`). The tests cover provider derivation and
     mobile pagination, not active-speaker priority
     (`participant-grid.test.tsx:40-99`).

5. **Screen-share composition is split across two paths.**
   - Symptom: `ParticipantGrid` exposes `screenShareContent`, documented as an
     app-owned fallback when no real track exists, but uses it only inside the
     desktop presentation branch (`ParticipantGrid.tsx:28-40,337-357`).
   - `SpaceView` bypasses ParticipantGrid whenever a real screen-share track is
     present and renders `ScreenShareView` instead
     (`SpaceView.tsx:143-145,225-230`). The fallback prop is therefore not part
     of the real SpaceView screen-share path.
   - `showScreenShareIndicator` is destructured as `_showScreenShareIndicator`
     and never read (`ParticipantGrid.tsx:64-65`); the same dead prop exists in
     `ClassicParticipantGrid.tsx:27-28`.
   - Current status: still present. The active screen-share path is separately
     implemented in `ScreenShareView`, with a bottom or right thumbnail panel
     (`ScreenShareView.tsx:229-232,320-350`).

6. **Overflow can exceed the declared desktop grid.**
   - Symptom: the default grid adds a `+N more` item after slicing to the
     `maxVisibleParticipants` default of 25 (`ParticipantGrid.tsx:64-89,379-413`).
   - `getGridLayout(26)` returns five columns and five rows, but 25 visible
     Participants plus the overflow card are 26 grid items; CSS must create an
     implicit sixth row (`ParticipantGrid.tsx:93-109,380-412`).
   - That extra row is inside a fixed `h-full` grid with `place-items-center`,
     so clipping or compressed/overflowing tiles is possible at the exact
     boundary where the overflow card appears.
   - Current status: still present in Classic, whose `getGridLayout` and
     `totalGridItems` logic are identical (`ClassicParticipantGrid.tsx:56-80,325-359`).
     No test renders 25 or 26 Participants.

7. **A muted live track can remain a visible frozen/black video element.**
   - Symptom: `isTrackUsable` checks only that the track exists, is live, and is
     enabled; it does not check `MediaStreamTrack.muted`
     (`ParticipantTile.tsx:40-42`).
   - The `mute` event handler only forces a render and does not set a hidden or
     avatar state (`ParticipantTile.tsx:108-110`). `showVideo` remains true when
     the track is loaded, live, enabled, and not in `trackError`
     (`ParticipantTile.tsx:130-136`).
   - Current status: still present in Chalk and Classic
     (`ClassicParticipantTile.tsx:10-11,78-80,100-106`). The focused tests do not
     dispatch `mute`, assert `track.muted`, or verify a fallback frame
     (`participant-tile.test.tsx:11-23`).

8. **The single-tile aspect fix is narrower than the turnkey default path.**
   - Historical symptom: the 2026-08-10 browser journey reported remaining SDK
     caps and a single-Participant aspect constraint; the session says the
     stage was widened and the single tile changed to fill the stage
     (`scratchpad/history/2026-W33.md`).
   - Current code uses `aspectRatio="fill"` only in the default-grid single-
     Participant branch (`ParticipantGrid.tsx:383-390`).
   - `SpaceView` and `Chalk` still default to `focus`; the focus main tile omits
     `aspectRatio`, so it inherits ParticipantTile’s default `16:9`
     (`SpaceView.tsx:135`, `Chalk.tsx:258`, `ParticipantGrid.tsx:307-316`,
     `ParticipantTile.tsx:29,51`).
   - Current status: the old max-width cap is fixed, but default-focus single-
     Participant geometry has no direct test. The existing “fills the stage”
     test exercises `layout="grid"` only (`participant-grid.test.tsx:56-70`).

9. **Two full renderer trees duplicate the same layout behavior.**
   - Symptom: Chalk and Classic each carry the complete participant sorting,
     mobile branching, focus, presentation, grid, overflow, and carousel logic
     (`ParticipantGrid.tsx:1-422`, `ClassicParticipantGrid.tsx:1-366`). Tile media
     lifecycle code is also duplicated (`ParticipantTile.tsx:1-261`,
     `ClassicParticipantTile.tsx:1-213`).
   - The 2026-08-18 skin log says the first Classic implementation reused the
     redesigned tree, live review showed the wrong layout, and separate
     pre-redesign renderers were then restored
     (`scratchpad/history/2026-W34.md`).
   - Current status: still present. This is a verified drift risk: a behavior fix
     must be made twice, and current tests assert only a small Classic export/
     structure seam (`ClassicParticipantGrid.test.tsx:1-8`,
     `participant-tile.test.tsx:11-23`).

10. **Known issue logs contain a real layout incident, but no tile-specific
    black-tile or mirror incident.**

- The 2026-08-10 log records a production browser failure, a missing definite
  viewport-height parent, and later a wide-screen screenshot exposing SDK
  caps and a single-Participant aspect constraint
  (`scratchpad/history/2026-W33.md`).
- The same log records the resulting viewport and single-tile fixes, so those
  historical symptoms are not all still present (`scratchpad/history/2026-W33.md`).
- Repository-wide scratchpad searches for the requested exact phrases
  `black tile`, `object-fit`, and `mirror` found no direct incident entry;
  `flicker` appears only in generic WebRTC/realtime lessons, not a
  ParticipantGrid diagnosis. The current mute path above is code evidence,
  not a recorded black-tile reproduction.

11. **Geometry and media-state coverage is thin despite a green suite.**

- ParticipantGrid tests cover empty state, provider derivation, one grid
  tile, and five-Participant mobile pagination
  (`sdks/typescript/react/src/components/participant-grid/participant-grid.test.tsx:14-99`).
- ParticipantTile tests cover only the Classic visual seam and absence of
  rough chrome (`sdks/typescript/react/src/components/participant-tile/participant-tile.test.tsx:11-23`).
- SpaceView tests cover composition, skin attributes, max-width absence,
  panels, and that a live track chooses ScreenShareView, but not actual tile
  geometry, pinned selection, active-speaker selection, muted tracks, or
  `screenShareContent` (`sdks/typescript/react/src/components/space-view/SpaceView.test.tsx:56-175`).
- Current status: the missing cases remain unproved by automation.

## C. Test and typecheck status

- Command run exactly: `pnpm --filter ./sdks/typescript/react test 2>&1 | tail -80`.
- Exit status: 0.
- Tail of output:

  ```text
  > @q9labsai/chalk-react@4.0.1 test /Users/macmini/code/chalk/sdks/typescript/react
  > pnpm exec vitest run --config ./vitest.config.ts

   RUN  v4.1.10 /Users/macmini/code/chalk/sdks/typescript/react

   Test Files  86 passed (86)
        Tests  190 passed (190)
     Start at  18:04:26
     Duration  6.29s (transform 8.08s, setup 7.29s, import 28.01s, tests 3.93s, environment 6.32s)
  ```

- No failing tests were reported. The stage-related files are included in the
  86 passing files; no test name failed for ParticipantGrid, ParticipantTile,
  SpaceView, or ScreenShareView.
- `sdks/typescript/react/package.json` has `check-types`, not a `typecheck`
  script. Its script is `tsc --project tsconfig.check-types.json --noEmit`.
- Command run: `pnpm --filter ./sdks/typescript/react check-types 2>&1 | tail -80`.
- Exit status: 0. Output:

  ```text
  > @q9labsai/chalk-react@4.0.1 check-types /Users/macmini/code/chalk/sdks/typescript/react
  > tsc --project tsconfig.check-types.json --noEmit
  ```

- The green suite does not prove the geometry and media-state cases listed in
  B.11; those cases are currently absent rather than failing.
- GitHub issue lookup was attempted with
  `gh issue list --limit 100 --search "tile OR grid OR layout OR stage"`.
- It failed before returning issues: `error connecting to api.github.com` and
  `check your internet connection or https://githubstatus.com`.

## D. Web app integration constraints

- Public `/space` is an Outlet route (`apps/web/src/routes/space.tsx:1-7`). The
  slug route mounts `DashboardSpacePage`, which enters `JoinSpacePage`
  (`apps/web/src/routes/space.$slug.tsx:1-14`).
- The live web wrapper gives the SDK a definite viewport: `<main
className="h-dvh min-h-0 w-full overflow-hidden">` and mounts turnkey
  `<Chalk />` inside it (`apps/web/src/components/space/SpacePage.tsx:149-163`).
- The wrapper enables Entrance, defaults microphone and camera on, supplies the
  logo and Space name, and leaves layout unspecified, so the SDK default is
  focus (`apps/web/src/components/space/SpacePage.tsx:151-161`,
  `sdks/typescript/react/src/components/chalk/Chalk.tsx:249-262`).
- Chalk’s root is `h-full min-h-0 overflow-hidden`; its inner shell is a
  full-size column (`SpaceView.tsx:193-205`).
- The stage row is `flex-1 min-h-0`, full width, `overflow-hidden`, with
  responsive horizontal padding: `px-3`, `sm:px-5`, `lg:px-8`, plus top/bottom
  spacing (`SpaceView.tsx:225-230`). Classic uses the same row constraints
  (`ClassicSpaceView.tsx:157-160`).
- With an active desktop panel, the row becomes
  `lg:grid lg:grid-cols-[minmax(0,1fr)_340px]`, so the stage receives the
  remaining width and the panel is 340px (`SpaceView.tsx:225-246`).
- At narrow widths the panel is absolute, `inset-x-3 top-20 bottom-24`, z-40,
  and `overflow-hidden`; this intentionally overlays the stage while leaving
  space above the bottom dock (`SpaceView.tsx:234-246`).
- The control bar is an absolute bottom layer at z-30. Desktop and mobile use
  separate density variants (`SpaceView.tsx:249-260` and
  `ClassicSpaceView.tsx:173-214`).
- SpaceView computes `hasActiveScreenShare` from a real screen track and forces
  `renderedLayout` to presentation (`SpaceView.tsx:142-145`). A real share
  renders `ScreenShareView`; whiteboard takes precedence when open
  (`SpaceView.tsx:225-230`).
- The screen-share view uses a full-size flex surface, a contained main share,
  and optional thumbnails at the bottom or right. The default thumbnail panel
  is 9rem high at the bottom (`ScreenShareView.tsx:229-232,320-350`).
- The development SDK preview itself is `h-screen overflow-hidden` and places
  a toolbar above `PreviewSpaceView` (`apps/web/src/components/sdk-preview/SdkPreviewGallery.tsx:91-149`).
- Preview URL state exposes `focus`, `grid`, and `presentation`, stage values
  `people`, `share`, `whiteboard`, and participant counts `0,1,2,5`
  (`apps/web/src/components/sdk-preview/preview-state.ts:22-47`).
- The preview fixture has five deterministic Participants: local Hasan, Nora,
  Akash, Sofia, and Malik (`apps/web/src/components/sdk-preview/sdk-preview-fixtures.ts:16-55`).
- The preview maps share state to presentation and whiteboard state to focus,
  and supplies participants from the count control
  (`apps/web/src/components/sdk-preview/SdkPreviewGallery.tsx:41-57`).
- Preview screen share and whiteboard are local absolute overlays at `inset-3`
  or `sm:inset-6`, while the PreviewSpaceView feature flags disable real
  screen-share and whiteboard controls (`SdkPreviewGallery.tsx:135-160,196-204`).
- The fixture marks Nora as screen sharing when `stage=share`, but without a
  real MediaStreamTrack the production `hasActiveScreenShare` check is false;
  the overlay is therefore the showcased share state
  (`sdk-preview-fixtures.ts:165-172`, `SpaceView.tsx:142-145`).
- The preview default is two Participants, focus layout, Classic skin, and the
  warm-charcoal palette (`apps/web/src/components/sdk-preview/preview-state.ts:76-93`).
- The web integration therefore exercises 0, 1, 2, and 5 Participants plus
  share/whiteboard overlays, but does not exercise 3/4 Participant mobile
  geometry, 25/26 overflow, real ScreenShareView media, or mute-track fallback.

## E. Git trajectory

1. `71a8d920` (2026-08-05) shipped the turnkey Space experience and the
   current context-composed stage surface (`git log --oneline -30 -- sdks/typescript/react/src/components/participant-grid sdks/typescript/react/src/components/participant-tile sdks/typescript/react/src/components/space-view`).
2. `78246ea9` (2026-08-04) added the URL-addressable SDK preview gallery with
   deterministic Space states and a ScreenShareMock.
3. `4d4980b5` and `a4b15653` (2026-08-03) added paired light and composable dark
   themes around the existing stage surface.
4. `819575f1` (2026-08-16) added Cosmic Chalk and changed ParticipantGrid with
   29 lines plus focused tests; it did not change the layout model.
5. `ef32c45d` (2026-08-16) drew the Chalk renderer: ParticipantGrid changed by
   98 lines, ParticipantTile by 84, and SpaceView by 25; the mobile and desktop
   behavior was largely retained while the primitives became hand-drawn.
6. `f209bee3` (2026-08-10) was a corrective web/layout commit. It removed the
   1440/1320 max-width caps, added unload cleanup, changed the grid’s single
   tile to `aspectRatio="fill"`, and added regression tests.
7. The same f209 session log says live wide-screen proof exposed the caps and
   single-Participant aspect constraint before that fix
   (`scratchpad/history/2026-W33.md`).
8. `487df466` (2026-08-18) added Classic and Chalk skins, including parallel
   Classic participant-grid/tile/SpaceView renderers.
9. The 2026-08-18 skin log records that the first Classic attempt preserved the
   wrong redesigned layout; separate pre-redesign renderers were then restored
   (`scratchpad/history/2026-W34.md`).
10. The requested path log contains no revert commit. The trajectory is additive
    redesign, a viewport/aspect correction, then a skin split that increased
    behavior duplication and left the mobile/pin/media-state questions open.

## F. Open questions the redesign must answer

- Should mobile default to the mockup’s dominant active/pinned tile plus stable
  filmstrip, or to equal 2x2/vertical tiles?
- What exact priority wins when a Participant is pinned, another is active
  speaker, and a third is sharing a screen?
- Can a local active speaker become the spotlight main tile when remote
  Participants are present?
- What is the intended geometry for 1, 2, 3, 4, 5, 6, and more Participants
  on mobile and desktop?
- What is the hard maximum of simultaneous visible tiles, and how must the
  overflow affordance behave at the boundary?
- Should overflow be a sixth grid item, a paged surface, a filmstrip affordance,
  or a Participants-panel handoff?
- Which camera aspect/crop policy is intended for dominant tiles, equal grid
  tiles, and thumbnails?
- Should the turnkey default focus path use fill geometry for one Participant?
- What should a muted, loading, ended, or failed track show: avatar, last frame,
  black frame, or an explicit state?
- Should the local Participant’s camera be mirrored, and is that policy different
  for remote Participants and screen share?
- Is `screenShareContent` the supported no-track fallback, and if so, where is
  it injected in the real SpaceView path?
- What contract should `showScreenShareIndicator` have, and should the
  indicator be in the tile, the filmstrip, or the stage header?
- Does screen share always replace the main stage, and are thumbnails always
  bottom on mobile and right on desktop?
- Should the layout selector remain effective on mobile, or should mobile
  auto-layout intentionally override the selected layout?
- Are the Classic and Chalk skins required to share identical layout/media
  behavior, and how will parity be tested if their DOM trees stay separate?
- Which theme tokens govern stage background, camera-off wash, speaker outline,
  labels, status icons, and screen-share chrome in each skin?
- Which browser/device proof is required for real mute/unmute, track replacement,
  screen-share rotation/zoom, safe-area dock spacing, and panel resizing?
