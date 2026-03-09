# Chalk Native Apps (iOS + Android) — Specs

Decision: build `apps/ios` + `apps/android` first. Extract SDKs later once UX + stability proven.

Companion docs:

- Deep baseline + protocol notes: `apps/native/FINDINGS.md`
- App requirements + acceptance criteria: `apps/native/REQUIREMENTS.md`

## Scope (MVP)

- Multi-participant meeting (group call)
- Screen sharing
- Recording (RealtimeKit composite recording)
- Cloudflare RealtimeKit as RTC backend + client SDK

## UI (custom, not implemented here)

Design references (provided by you):

- `apps/native/lobby-mobile.png`
- `apps/native/meeting-mobile.png`

UI implementer contract:

- Treat the PNGs as the source of truth for layout, spacing, typography, and control placement.
- Implement in native UI frameworks (SwiftUI/UIKit, Android Compose/View). No business logic in UI layer.
- UI must only bind to MeetingKit view-model state + invoke MeetingKit actions (no direct WS/HTTP/RTK calls).
- UI must surface errors with a clear retry path (join failure, WS disconnect, RTK init/join failure).

UI requirements (MVP screens):

- Lobby (pre-join)
  - Inputs: display name, optional room code/id (if not deep-linked)
  - Device preview: local camera tile + mic level (best-effort)
  - Toggles: mic, camera
  - Primary: Join
  - Secondary: Settings (optional), back
  - Error states: missing permissions, token/join failure, network offline
- Meeting
  - Header: room title/code, connection badge, recording badge (if active)
  - Video area: grid + active speaker emphasis (switchable)
  - Local controls: mic, cam, switch camera, speaker route, leave
  - Feature controls: chat, participants, whiteboard, reactions, hand raise, screenshare, recording (host-only)
  - Panels: chat thread, participant list (with host controls), whiteboard panel
- Whiteboard (panel)
  - WebView canvas (Excalidraw)
  - Read-only mode when `canDraw=false` (view mode)
  - Cursor presence (remote cursors)
  - Image insert supported (files sync via presigned URLs)
- End screen
  - Left/ended state; actions: rejoin, back to lobby, report issue (optional)

UI requirements (interaction specifics):

- Panels: open/close must preserve meeting state; never leave the room.
- Recording: show always-on indicator when active; require confirm on stop (host-only).
- Screenshare: start/stop affordance; clear "sharing" state; handle "permission revoked" gracefully.
- Permission: when drawing permission changes, UI updates immediately (disable tools if read-only).
- Orientation: portrait-first; landscape must not break controls; safe-area respected.

## User Stories (Dev)

- As a dev, I can join a meeting with an `authToken` from our backend.
- As a dev, I can render local + remote participant video tiles.
- As a dev, I can toggle mic/camera, switch camera, and handle interruptions (route change / focus loss).
- As a dev, I can start/stop screen share and surface screen-share state/events in UI.
- As a dev/admin, I can start/stop recording and observe recording state → download URL.

## User Stories (End User)

- Join meeting, see/hear multiple participants, leave reliably.
- Mute/unmute, camera on/off, switch camera; audio routing (speaker/Bluetooth) stays correct.
- Share screen; others see it; user can stop sharing.
- Meeting can be recorded; users can be informed recording is active; recording completes and is retrievable.

## Requirements

## Reference (existing implementation)

RealtimeKit is already implemented in `sdk-core` (web/TS) and should be the behavioral baseline for native apps:

- RealtimeKit init/join + retry/timeouts: `packages/sdk-core/src/client.ts`
- Room wrapper mapping RTK participants/tracks → Chalk types: `packages/sdk-core/src/room.ts`
- Token flow expects API to return `tokens.rtcToken` (RealtimeKit auth token): `packages/sdk-core/src/types.ts`
- Recording state/webhooks scaffolding: `packages/sdk-core/src/managers/recording-manager.ts`, `packages/sdk-core/src/webhooks/*`

## Backend Integration (essential)

RealtimeKit handles A/V transport. Our backend still owns the room “product”:
chat, whiteboard sync, participant state sync, reactions, hand raise, recording control/state, transcript persistence.

Native apps must replicate the proven web flow:

1. HTTP `addParticipant` → receive `accessToken` (API/WS) + `rtcToken` (RTK).
2. Connect Chalk WebSocket `/ws` using `Sec-WebSocket-Protocol: chalk, token.<accessToken>` (preferred).
3. Init/join RTK meeting using `rtcToken`.
4. Use Chalk WS events as source of truth for non-media features; use RTK events/tracks for media + screenshare.

Details + message catalogs live in `apps/native/FINDINGS.md`.

### Meeting + Participants

- Must support multiple participants (grid + active speaker layouts).
- Must expose connection lifecycle: `connecting`, `connected`, `reconnecting`, `disconnected/failed`.

### Screen Sharing

- Must support enabling/disabling screenshare for the local user (permissions gated by preset).
- iOS: implement ReplayKit Broadcast Upload Extension + app groups (RealtimeKit iOS screen share guide is explicitly flagged as “being updated”; treat as high-risk area).

### Recording

- Composite recording supported; recordings are created by a bot participant and uploaded to RealtimeKit storage, then retrieved via a download URL.
- Must support: record-on-start and manual start/stop.
- Recording duration edge-case: very short recordings (< ~5s) can fail/errored; avoid start/stop immediately in UX.
- Retention: recordings expire after 7 days unless exported.

### Observability

- Structured logging with session context (meetingId/roomId, participantId, platform, SDK versions).
- Surface actionable error codes/messages for: auth, permissions, network, media, screenshare, recording.

## Milestones (apps-first → SDK later)

1. iOS app: join/leave + video/audio + multi-participant tiles
2. Android app: join/leave + video/audio + multi-participant tiles
3. Screenshare on both platforms (iOS extension + Android projection)
4. Recording control + recording status UX + download URL flow
5. Hardening: background/foreground, interruptions, reconnection, device routing
6. Extract “Core” modules into SDKs + ship wrappers (later)

## Cloudflare RealtimeKit Docs (starting points)

Recording:

- Recording guide (workflow, retention, status updates): https://developers.cloudflare.com/realtime/realtimekit/recording-guide/
- Start recording: https://developers.cloudflare.com/realtime/realtimekit/recording-guide/start-recording/

Screen sharing:

- Screensharing basics (enable/disable + events): https://docs.realtime.cloudflare.com/guides/capabilities/screensharing/basics
- iOS screenshare (ReplayKit extension): https://docs.realtime.cloudflare.com/ios-core/local-user/screen-share-guide

Platform quickstarts:

- Getting started (REST APIs + SDKs): https://docs.realtime.cloudflare.com/getting-started
- Android quickstart: https://docs.realtime.cloudflare.com/android
- Android Core quickstart (headless/data layer): https://docs.realtime.cloudflare.com/android-core
