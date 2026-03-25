# Mobile/Web Participant Stage Parity Spec

Date: 2026-03-25
Owner: Chalk SDK
Scope: `packages/sdk-react` vs `packages/sdk-react-native`

## Goal

Make React Native meeting-stage behavior match web meeting-stage semantics.

Web is source of truth.

Parity target applies at SDK level first.
`apps/mobile` feature flags may still keep some capabilities disabled.

Also: native meeting layout must scale beyond the current single-participant stage model.
High-volume participant handling is a first-class requirement, not a follow-up polish item.

Consult synthesis:

- GPT + Gemini agree on content-first stage semantics, local-share suppression, and stronger grid scaling requirements.
- Main disagreement was compact `whiteboard + screen share` precedence.
- This spec resolves compact precedence to `whiteboard > screen share > grid` to stay aligned with current web branching and keep collaboration content primary.

## Source Of Truth

Web stage derivation:

- `packages/sdk-react/src/components/full/meeting-room/useMeetingRoomDerived.ts:13`
- `packages/sdk-react/src/components/full/meeting-room/MeetingRoomStage.tsx:33`
- local-share suppression regression test:
  `packages/sdk-react/src/__tests__/full/MeetingRoom.test.tsx:82`

Native current behavior:

- `packages/sdk-react-native/src/components/NativeMeetingRoom.tsx:73`
- duplicate native helper:
  `packages/sdk-react-native/src/components/NativeMeetingRoom.tsx:358`
- extracted helper:
  `packages/sdk-react-native/src/utils/pick-stage-participant.ts:5`

App wiring note:

- `apps/mobile/App.tsx:345` passes `features={{ screenShare: false }}`

## Current Web Behavior

Web derives stage mode from content state, not from layout selection.

- `screenSharer = participants.find((participant) => participant.isScreenSharing)`
- `isSplit = !isMobile && enableWhiteboard && isWhiteboardOpen && showScreenShare`
- `isStageMode = isSplit || whiteboardOpen || activeScreenShareTrack`
- `allParticipants = [local, ...others]`

Render rules:

- if `isStageMode === false`: render `VideoGrid`
- if whiteboard + screen share on large layout: render split stage
- if whiteboard only: whiteboard owns stage
- if screen share only: screen share owns stage
- if local user is sharing: hide local share preview in main stage to avoid mirror loops
- filmstrip remains available beside/below stage content

Important nuance:

- on web mobile, non-stage mode still uses `VideoGrid`; it does not spotlight an active speaker just because layout is `spotlight`/`sidebar`

## Current Native Behavior

Native stage is layout-driven.

- `layout.layout === "grid"` => grid
- any other layout => participant spotlight stage

Selection rules for native participant stage:

- sharer participant if `screenShare.sharerParticipantId` exists
- else `activeSpeaker`
- else first remote with video
- else first remote
- else local

Render rules:

- when `screenShare.isActive`, stage track prefers screen-share track
- otherwise stage track prefers selected participant video
- stage surface always renders participant-centric content
- no whiteboard-owned stage
- no split stage
- no local-share suppression placeholder
- no filmstrip beside stage

Extra cleanup issue:

- `pickStageParticipant` exists twice

## Parity Gaps

1. Stage trigger semantics differ.
   Web: content-driven.
   Native: layout-driven.

2. Participant spotlight semantics differ.
   Web mobile non-stage uses grid.
   Native non-grid layouts create a participant stage.

3. Screen share stage differs.
   Web stage is screen-share-first.
   Native stage still resolves a participant, then a track.

4. Local share safety differs.
   Web hides local share preview in the main stage.
   Native would try to render the local share track.

5. Whiteboard stage differs.
   Web whiteboard can own stage.
   Native whiteboard only exists as a panel/action flow today.

6. Split-stage behavior missing.
   Web can render screen share + whiteboard together on larger screens.
   Native cannot.

7. Participant ordering differs.
   Web explicitly normalizes to local-first for strip/stage context.
   Native grid uses manager order directly.

8. Layout contract drift.
   Shared UI manager layout values are `grid | spotlight | speaker | auto`.
   Native currently treats every non-grid value as “participant stage”.
   Web does not.

## Parity Decision

Adopt web semantics in native.

Meaning:

- Stage mode must be derived from active content:
  whiteboard and/or screen share
- Layout mode must control presentation details only:
  grid density, strip direction, control placement
- Participant spotlight fallback should not be the default meaning of non-grid layout in native
- Grid strategy must be robust for high participant counts; parity cannot regress multi-participant usability

## Scaling Requirement

Current native stage assumes one primary participant too often.
That is insufficient for larger rooms.

Target:

- support small rooms cleanly
- degrade gracefully as participant count grows
- keep non-stage mode viable for high-volume calls
- avoid architecture that only works for 1 primary participant + a few thumbnails

Practical implication:

- participant grid strategy is a core part of parity work
- stage work and grid work should be designed together
- native should not depend on participant spotlight as the default answer to layout complexity

## Target Native Behavior

### 1. Derived meeting-stage state

Create a native derived helper/hook with one canonical stage-source resolver.

- `stageSource`
- `screenSharer`
- `screenShareTrack`
- `isSplit`
- `isStageMode`
- `allParticipants`

Recommended file:

- `packages/sdk-react-native/src/components/native-meeting-room/useNativeMeetingRoomDerived.ts`

Rules:

- `screenSharer = participants.find(isScreenSharing)` only as an input, not the final source of truth
- `screenShareTrack` must be resolved from the active screen-share source, with live track preference
- `stageSource` should be track/content-centric, not participant-centric
- `allParticipants = [local, ...others]`
- `showScreenShare = Boolean(screenShareTrack)`
- `isSplit = !isCompactViewport && enableWhiteboard && isWhiteboardOpen && showScreenShare`
- `isStageMode = isSplit || (enableWhiteboard && isWhiteboardOpen) || showScreenShare`

Recommended return shape:

- `mode`
- `screenSharer`
- `screenShareTrack`
- `allParticipants`
- `isSplit`
- `isStageMode`
- `primaryContent`
- `compactPolicy`

`isCompactViewport` must be native-derived.
Do not depend on web `window` heuristics from `UIManager`.
Use RN viewport info such as `useWindowDimensions`.

Track gating:

- do not enter full screen-share stage solely because `isScreenSharing === true`
- require a live track or an intentional placeholder state
- stale sharer IDs or pending track attachment must not force a broken stage

### 2. Stage render ownership

When `isStageMode` is false:

- render participant grid only

When `isStageMode` is true:

- if `isSplit`: render screen share + whiteboard
- else if whiteboard open: whiteboard owns stage
- else: screen share owns stage

Do not render active-speaker spotlight as the default stage content.

Compact precedence:

- `whiteboard > screen share > grid`

Wide precedence:

- `split(whiteboard, screen share) > whiteboard > screen share > grid`

### 3. Local screen-share suppression

If the active sharer is local and the stage source is local screen share:

- do not render the live local shared track in the main stage
- render a native equivalent of the web placeholder:
  “Screen share active”
  “Preview hidden in this window”

Goal:

- prevent mirror-loop UX

### 4. Participant strip / thumbnails

During stage mode:

- keep participant thumbnails available outside the main stage
- local participant first
- preserve raised hand / mute / speaking affordances already available in native tiles

Form factor rule:

- compact phones: bottom strip
- wide phones / tablets: side strip acceptable
- compact view should keep the strip simpler than web filmstrip chrome

Important:

- this strip is not a substitute for robust grid mode
- stage mode handles shared content
- grid mode handles high participant volume

### 5. Non-stage layout behavior

For native parity, `spotlight` / `speaker` / `auto` must not by themselves imply participant spotlight stage.

Non-stage mode should behave like web mobile:

- render grid/carousel-style participant layout
- optionally use layout value only for ordering/pinning later, not for forcing stage chrome
- remain usable at higher participant counts, not just 1 to 4 people

### 5a. Grid Strategy

Native needs an explicit participant-scaling strategy.

Requirements:

- robust from 1 participant to larger rooms
- predictable ordering
- no local duplication
- no sudden fallback into single-participant spotlight
- preserve important status affordances:
  speaking, mute, hand raise, screen share, host/local identity
- compact view should use paging/carousel/virtualized chunks as needed
- tablet/wide layouts may use denser grids

Behavior rules:

- 1 participant: full-bleed tile acceptable
- 2 to 4 participants: balanced grid
- 5+ participants: paged or virtualized grid strategy
- stage teardown must return to this scalable grid, not participant spotlight

Performance requirement:

- use RN list virtualization or paging intentionally
- do not render an unbounded number of live video tiles in one view tree
- orientation changes and split-screen resizing must not thrash layout state

Viewport requirement:

- `isCompactViewport` breakpoints must be stable across portrait/landscape transitions
- layout must adapt without dropping or duplicating participant tiles

Ordering requirement:

- normalize local-first where strip/stage context needs it
- avoid duplicate local rendering when combining `participants` + `localParticipant`
- preserve deterministic ordering for large rooms

### 5b. Layout Migration Note

Current native mental model:

- `grid` = grid
- non-grid = participant spotlight stage

Target native mental model:

- `grid` = non-stage participant layout
- non-grid values influence presentation only
- shared content decides whether stage mode exists

This is a behavior migration.
Any native layout controls, chips, or settings copy that imply “spotlight means single-participant stage” must be updated.

Implementation note:

- treat grid behavior as SDK-owned meeting layout logic, not app-level wiring

### 6. Whiteboard behavior

If whiteboard feature is enabled and open:

- whiteboard must become stage content
- if screen share also active and viewport is wide enough:
  render split stage
- if viewport is compact:
  prefer whiteboard-only or screen-share-only stage based on product decision

Recommended default for compact native parity:

- whiteboard wins over participant spotlight
- if both whiteboard and screen share are active on compact view, prefer whiteboard as primary stage and expose switcher/toggle in follow-up work if needed

This is the only area where exact visual parity may need native adaptation.
Behavioral parity still means participant spotlight should not displace active shared content.

## Non-Goals

- enabling mobile app screen share in `apps/mobile`
- redesigning all native meeting controls
- full visual parity with web CSS
- PiP parity

## Implementation Plan

1. Add native derived-state helper mirroring web semantics.
2. Define native grid strategy for low/high participant counts and local-first normalization.
3. Replace `layout.layout === "grid"` branching in `NativeMeetingRoom` with `isStageMode` branching.
4. Add dedicated native stage subviews:
   - `NativeScreenShareStage`
   - `NativeWhiteboardStage`
   - optional `NativeSplitStage`
5. Move participant-strip rendering out of grid-only path.
6. Remove duplicate `pickStageParticipant` from `NativeMeetingRoom.tsx`.
7. Keep `pickStageParticipant` only if still needed for explicit future spotlight mode.
   If unused after parity refactor, delete util + tests.

Suggested implementation slicing:

1. Foundation:
   - `useNativeMeetingRoomDerived`
   - canonical stage-source resolution
   - local-first normalization without duplication
2. Grid:
   - scalable compact/wide participant layout
   - paged or virtualized handling for high counts
3. Stage branching:
   - replace layout-driven spotlight
4. Screen share stage:
   - local suppression placeholder
5. Whiteboard stage
6. Tablet/wide split stage

## Test Plan

Add native regression coverage for:

1. screen share with remote sharer enters stage mode and renders screen share stage
2. local screen share shows “preview hidden” placeholder instead of live mirrored preview
3. whiteboard open enters stage mode even without screen share
4. whiteboard + screen share on wide viewport enters split stage
5. non-stage mode renders grid even when layout is `spotlight` / `speaker` / `auto`
6. participant ordering for strip/grid is local first
7. compact viewport does not use participant spotlight as fallback stage
8. high participant counts remain in scalable grid/paged grid rather than collapsing to single-participant stage
9. stage teardown returns to multi-participant grid correctly
10. local participant is not duplicated in grid normalization
11. remote sharer flagged without a live track does not force stage mode
12. orientation change preserves stable grid/stage decisions
13. whiteboard close/open transitions hand off correctly with active screen share
14. track interruption or external track end exits stage safely

Keep or update existing tests:

- `packages/sdk-react-native/src/utils/pick-stage-participant.test.ts`

Likely test destination:

- `packages/sdk-react-native/src/components/__tests__/NativeMeetingRoom.test.tsx`

## Open Product Call

Only unresolved product choice:

- on compact native view, when both whiteboard and screen share are active, should primary stage prefer whiteboard or screen share?

Recommended default:

- whiteboard first

Reason:

- closer to collaboration intent
- avoids silently falling back to participant spotlight
- still preserves content-first parity with web

## Summary

Web stage = content-first.
Native stage = layout-first.

Parity means native must stop treating non-grid layout as participant spotlight mode and instead let shared content own the stage, with mirror-loop protection, scalable participant layouts, and high-volume grid behavior as a core requirement.
