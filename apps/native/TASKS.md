# Chalk Native Apps — Tasks

Order matters. Spike risky stuff first.

## P0 — “Vertical Slice”

- [ ] iOS app skeleton: config (api/ws), join room, connect WS, init/join RTK (no UI polish)
- [ ] Android app skeleton: config (api/ws), join room, connect WS, init/join RTK (no UI polish)
- [ ] Participant ID mapping proof: Chalk `participantId` == RTK `userId` via backend `client_specific_id` (`apps/api/internal/domain/participant/service.go:252`)
- [ ] WS auth (subprotocol token): offer `chalk` + `token.<jwt>`; no query-param auth
- [ ] Room snapshot → participant roster rendering (basic list)

## P0 — Core Features (non-media)

- [ ] Chat: `chat.send` + `chat.message`
- [ ] Reactions: `reaction.send` + `reaction`
- [ ] Hand raise: `hand.raise/lower` + `hand.raised/lowered`
- [ ] Recording control (HTTP): start/stop + WS state
- [ ] Whiteboard sync: `whiteboard.sync` + `whiteboard.snapshot` + `whiteboard.update` + cursors + permissions
- [ ] Transcript persistence: RTK finals → WS `transcript` + `transcript.ack`

## P0 — Risk Spikes (do early)

- [ ] iOS screenshare: ReplayKit broadcast upload extension + app group + RTK screenshare
- [ ] Android screenshare: MediaProjection + RTK screenshare
- [ ] Background/foreground resilience (audio focus / interruptions)

## P1 — Hardening

- [ ] WS reconnect/backoff + token refresh on reconnect
- [ ] Retry strategy parity with `sdk-core` for RTK join timeouts
- [ ] Large payload handling (whiteboard) + WS read limit awareness
- [ ] Observability: structured logs + session context (roomId/participantId/tenantId)

