# Chalk Native Apps — Tasks

Order matters. Spike risky stuff first.

## P0 — “Vertical Slice”

- [ ] iOS app skeleton: config (api/ws), join room, connect WS, init/join RTK (UI wired)
- [ ] Android app skeleton: config (api/ws), join room, connect WS, init/join RTK (UI wired)
- [ ] Participant ID mapping proof: Chalk `participantId` == RTK `userId` via backend `client_specific_id` (`apps/api/internal/domain/participant/service.go:252`)
- [ ] WS auth (subprotocol token): offer `chalk` + `token.<jwt>`; no query-param auth
- [ ] Room snapshot → participant roster rendering (basic list)
- [ ] MeetingKit boundary: UI never touches WS/HTTP/RTK directly (only view-model state + actions)
- [ ] Add `apps/native/PROGRESS.md` and keep it updated per PR/commit

## P0 — UI Contract (for UI implementer)

- [ ] UI screens: Lobby, Meeting, Chat panel, Participants panel, Whiteboard panel, End screen (see `apps/native/SPEC.md`)
- [ ] UI binds only to MeetingKit state: connection, participants, local media, recording, chat, whiteboard, errors
- [ ] UI triggers only MeetingKit actions: join/leave, toggles, chat send, reaction, handraise, recording, screenshare, whiteboard open/close, permission grant/revoke
- [ ] UX: error + retry for join/ws/rtk failures (no silent failures)

## P0 — Core Features (non-media)

- [ ] Chat: `chat.send` + `chat.message`
- [ ] Reactions: `reaction.send` + `reaction`
- [ ] Hand raise: `hand.raise/lower` + `hand.raised/lowered`
- [ ] Recording control (HTTP): start/stop + WS state
- [ ] Whiteboard sync: `whiteboard.sync` + `whiteboard.snapshot` + `whiteboard.update` + cursors + permissions
- [ ] Transcript persistence: RTK finals → WS `transcript` + `transcript.ack`

## P0 — Whiteboard (Excalidraw in WebView)

- [ ] WebView host bundle: local assets (no CDN), deterministic build, loads Excalidraw + `@q9labs/chalk-whiteboard/collab`
- [ ] Bridge protocol implemented (native <-> WebView): `wb.init`, `wb.snapshot`, `wb.update`, `wb.cursor`, presign upload/download request/response
- [ ] Native forwards Chalk WS `whiteboard.*` to WebView; WebView emits `wb.sendUpdateV2`/cursor/sync/clear back to native
- [ ] Images: presign upload/download flows work end-to-end (best effort, with error state)

## P0 — Risk Spikes (do early)

- [ ] iOS screenshare: ReplayKit broadcast upload extension + app group + RTK screenshare (see `apps/native/RESEARCH_SCREENSHARE.md`)
- [ ] Android screenshare: MediaProjection + RTK screenshare (see `apps/native/RESEARCH_SCREENSHARE.md`)
- [ ] Background/foreground resilience (audio focus / interruptions) (see `apps/native/RESEARCH_AUDIO.md`)

## P1 — Hardening

- [ ] WS reconnect/backoff + token refresh on reconnect
- [ ] Retry strategy parity with `sdk-core` for RTK join timeouts
- [ ] Large payload handling (whiteboard) + WS read limit awareness
- [ ] Observability: structured logs + session context (roomId/participantId/tenantId)
