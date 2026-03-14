# Chalk Web-to-Mobile Meeting Parity Spec
Date: 2026-03-14
Status: source-of-truth implementation spec for the current web conferencing experience

## Goal
This document explains the current Chalk meeting experience across `apps/web`, `@q9labs/chalk-react`, `@q9labs/chalk-core`, and the current native baseline. The target audience is anyone cloning the repo and trying to reproduce the same experience elsewhere, especially on mobile. The target is behavioral parity, not a loose approximation: same phases, same defaults, same guardrails, same failure handling, same interaction model, same overall polish.

## Scope
Covered here:
- app entry into a room
- scheduled-room waiting behavior before the SDK lobby mounts
- SDK React pre-join lobby
- SDK React loading/joining state
- SDK React meeting room shell
- SDK React end-state handoff
- adjacent components around the main flow
- core join/session plumbing that shapes the experience
- parity requirements for a future mobile implementation

Not covered exhaustively:
- every atomic UI primitive
- every styling token
- post-meeting share pages beyond how they relate to room flow

## Layer Ownership
There are 4 layers:
1. `apps/web`
   - route entry, auth mode selection, scheduled-room gating, app-only overlays, branded end page
2. `packages/sdk-react`
   - turnkey conferencing experience and most user-facing meeting behavior
3. `packages/sdk-core`
   - joining, session lifecycle, RealtimeKit bootstrapping, websocket wiring, manager orchestration, room state
4. `packages/sdk-react-native`
   - provider + low-level hooks, but no turnkey native `VideoConference` equivalent yet

Consequence: mobile parity is not just a room UI port. It needs both SDK-level parity and app-level parity for the web-specific bootstrap behavior currently living in `apps/web`.

## Canonical Phase Model
The canonical phase contract lives in `packages/sdk-react/src/components/full/video-conference/types.ts`.

Phases:
- `lobby`
- `joining`
- `meeting`
- `end`

`packages/sdk-react/src/components/full/VideoConference.tsx` is the façade:
- `lobby` or `joining` -> `PreJoinLobby`
- `meeting` -> `MeetingRoom`
- `end` -> `EndScreen`

Everything else in the flow exists to move the user safely and consistently between those 4 states.

## End-to-End Flow
### 1. Join-link resolution
Public guest links enter through `apps/web/src/routes/j/$joinToken.tsx`.

Behavior:
- exchange opaque join token with the API
- store guest access token and room metadata in `sessionStorage`
- redirect to `/room/{room_name}`

Result: the room route becomes the universal entry point for both host/internal-auth users and guest/join-link users.

### 2. Room-route bootstrap
The main web room entry is `apps/web/src/routes/room/$roomId.tsx`.

Before mounting the SDK, the route:
- resolves the API base URL
- decides auth mode by inspecting join context
- fetches room metadata early when the route param looks like a UUID
- normalizes internal auth mode with `?auth=internal` when needed
- restores user defaults from storage

Web-stored defaults currently include:
- `chalk_default_name` or `chalk_display_name`
- `chalk_join_muted`
- `chalk_join_no_video`

### 3. Scheduled-room gate
If the room has `scheduled_start_at` and early join is not yet allowed, the web route does not mount the SDK. It renders an app-owned full-screen countdown screen instead.

Critical distinction:
- scheduled waiting is app logic
- it is not implemented by `VideoConference`

A mobile build that skips this gate will diverge from web before the user ever reaches the lobby.

### 4. SDK mount
Once entry is allowed, the route mounts `VideoConference` with:
- resolved `roomId`
- display `roomName`
- `userName`
- `role`
- feature flags
- default audio/video/layout behavior
- `onEnd` callback that persists meeting data and navigates to `/room/end`

## Pre-Join Lobby
The pre-join experience is owned by `packages/sdk-react/src/components/full/PreJoinLobby.tsx`.

### Purpose
The lobby is both:
- a media/device preview surface
- a final join confirmation surface

It is not a passive waiting screen. This is where the user confirms identity, media intent, theme, and selected devices before the room join begins.

### Layout
The shell is full-screen and composed from:
- `PreJoinHeader`
- left preview tile via `PreJoinPreviewPane`
- right join rail via `PreJoinJoinPanel`
- floating preview controls via `PreJoinFloatingControls`
- `SettingsDialog`
- `LoadingScreen` overlay during join
- `DiagnosticErrorSheet` when a visible error is present

Visual direction to preserve:
- immersive full-screen shell
- participant-colored gradient bloom around preview
- glassmorphism controls
- mirrored self-view
- large simple CTA copy

### State ownership
The lobby is composed from:
- `usePreJoinUiState`
  - display name
  - mic/camera enabled state
  - settings open state
  - local error
- `usePreJoinMedia`
  - preview media acquisition
  - device enumeration
  - active preview tracks
- `usePreJoinAudioMeter`
  - live input level
- `usePreJoinTheme`
  - dark/light theme resolution and syncing
- `useMeetingRoomSettings`
  - persisted settings reused between lobby and meeting room

### User-facing behavior
Display name:
- defaults to `userName`, falling back to `"Guest"`
- user edits stop automatic resync from props
- whitespace is trimmed before join
- empty trimmed names disable join

Media defaults:
- microphone off
- camera off

This applies both to manual join and auto-join when defaults are omitted.

Preview acquisition:
- prefer externally provided tracks if present
- otherwise acquire local preview tracks with `getUserMedia`
- enumerate devices on mount and on `devicechange`
- stop superseded tracks when device changes
- stop owned tracks on unmount

Important rule:
- preview selection and preview capture happen before join
- actual live-meeting device selection happens after join succeeds

Device selection exposed in floating controls:
- microphone toggle + microphone menu
- camera toggle + camera menu
- settings button
- optional picture-in-picture button

Speaker selection:
- exists in settings and in emitted join settings
- does not exist in the floating preview control pod

Lobby-selected device ids are preserved in `JoinSettings`:
- `selectedVideoDevice`
- `selectedAudioInput`
- `selectedAudioOutput`

Preview fallback hierarchy:
1. if video is enabled and a video track exists, show mirrored self video
2. otherwise show avatar fallback
3. if audio is enabled, animate the avatar and meter from live audio level

Errors:
- visible failures surface `DiagnosticErrorSheet`
- sheet includes error text, support code, retry, and back action
- retry clears local error and reruns join using current lobby state

### Loading state during join
The joining state is not a separate route. It is an overlay inside `PreJoinLobby`.

`packages/sdk-react/src/components/full/LoadingScreen.tsx` renders:
- full-screen participant-colored ambient aura
- rotating headline region
- three bouncing dots
- `role="status"` with polite announcements

The lobby underneath scales down, blurs, and fades behind the overlay.

Current headline rotation cadence: `1800ms`

Current supporting messages:
- Checking your camera and mic...
- Syncing room settings...
- Testing your connection...
- Preparing your preview...
- Opening a low-latency route...
- Choosing the fastest route...
- Almost there...

For mobile parity, preserve:
- a meaningful progress state rather than a blank spinner
- the identity-colored aura
- accessible status semantics

## Join Orchestration
Visible lobby state is driven by `useVideoConferenceController`, but the main join path is `useJoinFlow` in `packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts`.

Join rules:
- duplicate join clicks are ignored
- if already connected, UI moves directly to `meeting`
- phase moves `lobby -> joining -> meeting` on success
- transient failures are retried
- terminal failures return the user to `lobby`

Current retry cadence:
- retry after `500ms`
- retry after `1200ms`

Post-join device application:
- selected camera/mic/speaker ids from the lobby are applied after join succeeds
- implemented through `join-flow-device-tasks.ts` and `useJoinFlowTelemetry.ts`

Meaning:
- the initial join sends display name, role, and enabled audio/video state
- hardware-specific device selection is pushed into the live meeting after connection is established

Telemetry and diagnostics:
- wide events exist for join click, phase transitions, and post-join device selection
- incident breadcrumbs and support-code context are attached when failures become terminal

## Meeting Room
The room shell is owned by `packages/sdk-react/src/components/full/MeetingRoom.tsx`.

### Composition
The room is a full-screen immersive shell with 5 major regions:
1. ambient background layer
2. stage
3. side panel or mobile panel
4. bottom controls
5. overlays and settings

### State model
The room deliberately splits state:
- durable user preferences: `useMeetingRoomSettings`
- ephemeral room UI: `useMeetingRoomUiState`
- derived stage/panel composition: `useMeetingRoomDerived`
- lifecycle side effects: `useMeetingRoomLifecycle`
- theme sync: `useMeetingRoomTheme`

This split is important. The settings dialog is not a modal-local scratch state. It is a durable preference system.

### Persisted settings contract
Stored under `localStorage["chalk-meeting-settings"]`, current version `6`.

Categories:
- `audio`
  - selected input
  - selected output
  - output volume
  - noise suppression
- `video`
  - selected camera
  - background effect
- `appearance`
  - theme
  - ambient gradient mode
  - generated avatars
  - profile gradient
  - layout
  - filmstrip visibility
  - reduced motion
  - ambient background toggle
- `experience`
  - invite toast on join
  - default open chat
  - default open participants
  - default open transcription
  - auto-open picture-in-picture

Hydration is bidirectional:
- if stored device ids still exist, the room pushes them into runtime selection
- if runtime already has selected devices and settings are blank, settings are backfilled from runtime

### Visual model
The room is identity-colored using local participant-derived theme variables.

Polish decisions to preserve:
- full-screen shell with no page chrome
- animated ambient background unless disabled or reduced-motion
- darker background mode for a moodier room
- draggable room-name pill on desktop
- low-chrome layout that prioritizes content over chrome

### Stage rules
`useMeetingRoomDerived` controls stage mode.

Rules:
- screen share present -> stage mode
- whiteboard open -> stage mode
- whiteboard + screen share on desktop -> split stage

Outputs:
- plain room -> `VideoGrid`
- screen share -> `ScreenShareView`
- whiteboard -> `WhiteboardPanel`
- screen share + whiteboard -> `SplitStage`

Mirror suppression:
- if the local user is sharing, Chalk suppresses the self-preview in the main stage
- it shows explanatory UI instead
- this prevents infinite mirror loops

Filmstrip:
- shown only in stage mode
- collapsible
- vertical in sidebar layout
- horizontal otherwise

### Panels
`MeetingRoomPanels` renders one active panel at a time:
- chat
- participants
- transcription

Desktop:
- fixed-width right sidebar

Mobile:
- full-screen sheet-like panels

Important invariant:
- single active panel model

### Controls
`MeetingRoomControls` composes:
- desktop/mobile `ControlBar`
- `MobileControlSheet`
- desktop `ReactionPicker`

Capabilities exposed from the room:
- mute/unmute
- video on/off
- screen share
- recording
- hand raise
- whiteboard
- chat
- participants
- transcription
- reactions
- settings
- picture-in-picture
- leave

Current web hotkeys:
- `Mod+K` open settings
- `M` toggle mute
- `V` toggle video

Native does not need identical keyboard APIs, but it should preserve quick equivalents where the platform supports them.

### Overlays
`MeetingRoomOverlays` owns:
- reconnect/failed connection overlay
- guided tour
- invite modal
- invite toast
- audio playback renderer

Important behavior:
- copied share links strip `autoJoin`
- invite toast and invite modal are distinct surfaces
- remote audio playback is centralized through `AudioRenderer`
- per-participant volume is multiplied by master output volume

### Whiteboard behavior
When whiteboard is open:
- layout-affecting changes can dispatch delayed `resize` so Excalidraw relayouts correctly
- PiP capture can snapshot the whiteboard on an interval when needed

Whiteboard parity therefore includes stage behavior and resize/PiP semantics, not just “a drawing surface exists.”

## Connection, Reconnect, and End Semantics
### Connection state mapping
`useConferenceConnectionState` maps room status into:
- `connected`
- `connecting`
- `reconnecting`
- `failed`

If the low-level room becomes connected while UI still thinks it is in `lobby` or `joining`, the phase is forced to `meeting`.

### Disconnect grace window
`useSessionEvents` listens to session `disconnected` and `error`.

During meeting:
- disconnect starts a grace window
- if the session is still disconnected or failed when the timer expires, the room ends
- otherwise reconnect state is cleared and the user stays in the meeting

Current grace window: `8000ms`

### Leave and end
Visible leave opens a confirmation dialog.

On confirm:
- room enters exit animation
- disconnect grace state is cleared
- `leave()` is called
- `onEnd(buildEndData())` is fired
- phase moves to `end`
- `onLeave()` is fired

If leave throws, the room still emits end data and still transitions to `end`.

### End payload
`useMeetingStats` builds canonical `MeetingEndData` containing:
- room id
- duration
- transcripts
- recording id
- peak participant count
- total participant sessions
- host id
- started/ended timestamps
- stats for chat, reactions, hand raises, screen share count, whiteboard usage, and recording duration

On web, `apps/web/src/routes/room/$roomId.tsx` stores that payload in `localStorage["data"]` and navigates to `/room/end`. The branded web end page is app-owned, not SDK-owned.

## Components Around The Main Flow
### App-only overlays on top of the SDK room
The current room route adds:
- `WhiteboardKeyboardShortcut`
  - `W` toggles whiteboard unless focus is inside an input/textarea
- `ReactionBubblesOverlay`
  - app-owned floating reaction layer using SDK interaction state

If mobile wants identical feel, these need explicit native equivalents or an intentional parity decision.

### WaitingRoom component
`packages/sdk-react/src/components/composite/WaitingRoom.tsx` exists as a host admission panel for people waiting to be admitted.

Important distinction:
- this is not the same thing as the scheduled-room countdown screen in `apps/web/src/routes/room/$roomId.tsx`
- the default web room route does not currently mount this component as part of the main flow

### Nearby but non-primary surfaces
These exist in the SDK but are not the current source of truth for the default mounted room shell:
- `MeetingHeader`
- `MeetingRoomTopBar`

Useful references, but not the core parity target.

## Current Native Position
`packages/sdk-react-native` already exposes:
- `ChalkNativeProvider`
- session access
- hooks for connection, participants, chat, transcripts

What it does not yet expose:
- turnkey native `VideoConference`
- native `PreJoinLobby`
- native `MeetingRoom`
- native `EndScreen`

Translation:
- transport/session parity is already feasible
- UI/phase-shell parity still needs to be implemented natively on top of those contracts

## Mobile Parity Rules
### Must match exactly
- same 4-phase model: `lobby`, `joining`, `meeting`, `end`
- same default mic/camera-off behavior
- same trimmed-name join rule
- same schedule gate before lobby appears
- same post-join device selection semantics
- same transient join retry behavior
- same disconnect grace behavior
- same support-code-based error surfacing
- same feature-flag semantics
- same single-active-panel model
- same stage and split-stage switching rules
- same self-screen-share mirror suppression
- same persistent settings categories and hydration behavior
- same meeting stats and end payload semantics

### Can differ in form factor
- modal vs sheet presentation
- exact header density
- drag affordances
- native PiP APIs
- native haptics or shortcut mappings
- exact implementation of live audio meter and camera preview

### Should still feel the same
- identity-colored surfaces
- low-chrome immersive room shell
- intentional joining state, not generic spinner-only UI
- chat, participants, and transcript as room-adjacent panels
- clear reconnect interruption handling
- polished invite/share flow

## Acceptance Checklist For A Native Rebuild
- user hits room entry and gets the same auth/schedule behavior as web
- lobby opens with mic/camera off and editable name
- preview uses live camera if enabled, avatar/audio pulse if not
- selected camera/mic/speaker are remembered and applied after join
- join shows meaningful progress messaging
- room switches correctly between grid, stage, and split stage
- local screen share never mirrors into itself
- chat, participants, and transcript preserve one-panel-at-a-time behavior
- reconnect overlay appears during grace window and escalates correctly
- leave and disconnect both produce equivalent meeting-end semantics
- durable settings survive across sessions

## Primary Source Map
App entry and flow:
- `apps/web/src/routes/j/$joinToken.tsx`
- `apps/web/src/routes/room/$roomId.tsx`
- `apps/web/src/routes/room/end.tsx`
- `apps/web/src/lib/internalAuth.ts`

SDK React façade and controller:
- `packages/sdk-react/src/components/full/VideoConference.tsx`
- `packages/sdk-react/src/components/full/video-conference/types.ts`
- `packages/sdk-react/src/components/full/video-conference/useVideoConferenceController.ts`
- `packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts`
- `packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts`
- `packages/sdk-react/src/components/full/video-conference/useConferenceConnectionState.ts`
- `packages/sdk-react/src/components/full/video-conference/useConferenceMeetingActions.ts`
- `packages/sdk-react/src/components/full/video-conference/useMeetingStats.ts`

Lobby and joining:
- `packages/sdk-react/src/components/full/PreJoinLobby.tsx`
- `packages/sdk-react/src/components/full/LoadingScreen.tsx`
- `packages/sdk-react/src/components/full/prejoin-lobby/*`

Meeting room:
- `packages/sdk-react/src/components/full/MeetingRoom.tsx`
- `packages/sdk-react/src/components/full/meeting-room/*`
- `packages/sdk-react/src/hooks/useMeetingRoomSettings.ts`

Core join/session:
- `packages/sdk-core/src/session/chalk-session.ts`
- `packages/sdk-core/src/client.ts`
- `packages/sdk-core/src/conference-client/join-session.ts`

Native baseline:
- `packages/sdk-react-native/src/context/chalk-native-provider.tsx`
- `packages/sdk-react-native/src/index.ts`

Key tests:
- `packages/sdk-react/src/__tests__/full/PreJoinLobby.test.tsx`
- `packages/sdk-react/src/__tests__/full/LoadingScreen.test.tsx`
- `packages/sdk-react/src/__tests__/full/MeetingRoom.test.tsx`
- `packages/sdk-react/src/__tests__/full/VideoConference.prejoin-devices.test.tsx`
- `apps/web/src/lib/joinLinkRedirect.test.ts`
