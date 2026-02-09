# Mission of Clarity — Native Apps (iOS + Android)

Living doc. Write findings. Correct freely. No shame; only accuracy.

Goal: build `apps/ios` + `apps/android` (custom UI) that replicate the *behavioral* flow proven in web (`sdk-core` + `sdk-react`), while moving runtime to native (Swift/Kotlin).

Companion docs:
- Spec + user stories + UI references: `apps/native/SPEC.md`
- App requirements (what we must implement): `apps/native/REQUIREMENTS.md`

## Reference Baseline (existing)

- Join/connect orchestration (web): `packages/sdk-react/src/components/full/VideoConference.tsx`
- Session lifecycle + managers: `packages/sdk-core/src/session/chalk-session.ts`
- Backend HTTP client + endpoints: `packages/sdk-core/src/api-client.ts`
- Backend WebSocket client + protocol: `packages/sdk-core/src/ws-client/*`
- Backend WebSocket server: `apps/api/internal/interfaces/http/handlers/websocket.go`, `apps/api/internal/interfaces/websocket/*`
- Whiteboard collab: `packages/sdk-react/src/components/full/WhiteboardPanel.tsx`, `apps/api/internal/interfaces/websocket/whiteboard_state*.go`

## System Split (source of truth)

Cloudflare RealtimeKit (RTK):
- Media transport: audio/video between participants
- Media state + tracks: local/remote audioTrack/videoTrack/screenShareTrack
- Screenshare enable/disable (local) + remote screenshare events
- Active speaker events
- Transcripts (SDK emits interim/final; we persist finals to our backend)

Chalk Backend (HTTP + WebSocket):
- Authentication, tenants, rooms, participant records
- Join flow: issues `accessToken` (our API+WS) and `rtcToken` (RTK)
- Room state sync + participant presence (`room.snapshot`, `participant.*`)
- Chat (`chat.send` → `chat.message`)
- Reactions + hand raise (`reaction.send`, `hand.raise/lower`)
- Recording control and state (`/recordings/start|stop` + WS `recording.*`)
- Whiteboard sync + permissions (`whiteboard.*`, `permission.*`)
- Transcript persistence over WS (`transcript` → `transcript.ack`)

## End-to-End Flow (what native apps must replicate)

### 1) Acquire token(s)

Typical:
1. App authenticates user with your app backend (not Chalk).
2. App backend calls Chalk API to create/join room + add participant.
3. Chalk API returns:
   - `accessToken` (JWT) — for Chalk HTTP + Chalk WebSocket
   - `rtcToken` — for RealtimeKit meeting join
   - `participantId`, `room.id`, `tenantConfig`, `shouldStartRecording`, etc.

Implementation reference: `packages/sdk-core/src/api-client.ts` (`addParticipant`, `transformJoinResponse`).

### 2) Connect Chalk WebSocket (`/ws`)

Backend prefers token via WebSocket subprotocol header:
- Client offers subprotocols: `["chalk", "token.<accessToken>"]`
- Server accepts subprotocol `chalk`, but still parses the offered list to extract `token.<...>`

Server reference: `apps/api/internal/interfaces/http/handlers/websocket.go` (token parsing + `AcceptOptions.Subprotocols`).
Client reference: `packages/sdk-core/src/ws-client/base.ts` (protocols array).

On connect server sends:
- `connected` (registration payload)
- `room.snapshot` (participants, recording state, `lastSeq`)
and broadcasts `participant.joined` to others.

### 3) Connect RealtimeKit with `rtcToken`

Init RTK client with `rtcToken`, then `join()`.

Reference:
- Web/TS: `packages/sdk-core/src/client.ts` (`RealtimeKitClient.init()` + `join` retry)
- RN: `packages/sdk-react-native/src/ChalkProvider.tsx` (RTK hook + `join`)

### 4) Ongoing sync

- Participant list/state: from WS `room.snapshot` + `participant.*` deltas.
- Media tracks: from RTK participant events; mapped into participant objects.
- Screen share: controlled + observed via RTK (no Chalk WS message types for screenshare).
- Whiteboard: all over Chalk WS (snapshot + updates + cursor + permissions).
- Chat/reactions/hand raise: all over Chalk WS.
- Recording:
  - control via HTTP `/recordings/start|stop`
  - state via WS `recording.started|stopped` + snapshot flags.
- Transcript persistence: RTK transcript events (finals) → send to Chalk WS as `transcript`.

## Backend HTTP Surface (native apps must call)

From `packages/sdk-core/src/api-client.ts` and `apps/api/internal/interfaces/http/router.go`:

- Auth:
  - `POST /api/v1/auth/token`
  - `POST /api/v1/auth/refresh`
- Rooms:
  - `POST /api/v1/rooms` (create)
  - `GET /api/v1/rooms/:id`
  - `POST /api/v1/rooms/:id/end`
- Participants:
  - `POST /api/v1/rooms/:id/participants` (join)
  - `POST /api/v1/rooms/:id/participants/bulk`
  - `DELETE /api/v1/rooms/:id/participants/:pid`
  - `POST /api/v1/rooms/:id/participants/:pid/token` (refresh token)
- Recording:
  - `POST /api/v1/rooms/:id/recordings/start`
  - `POST /api/v1/rooms/:id/recordings/stop`
  - `GET /api/v1/recordings/:id`
  - `GET /api/v1/recordings/:id/download`
- Whiteboard files (R2 presign):
  - `POST /api/v1/rooms/:id/whiteboard/files/presign-upload`
  - `POST /api/v1/rooms/:id/whiteboard/files/presign-download`
- Transcripts:
  - `GET /api/v1/rooms/:id/transcripts`

## Chalk WebSocket Protocol (what native apps must implement)

### Endpoint + auth

- URL: `GET /ws` (same base as API host)
- Auth JWT:
  - Preferred: `Sec-WebSocket-Protocol: chalk, token.<accessToken>`
  - Deprecated fallback: `?token=<accessToken>&room=<roomId>` (token in logs risk)

SDK reference: `packages/sdk-core/src/ws-client/base.ts` + `packages/sdk-core/src/ws-client/url.ts`.
Server reference: `apps/api/internal/interfaces/http/handlers/websocket.go`.

### Message envelope

- JSON: `{ "type": "<string>", "payload": <any> }`

Server structs: `apps/api/internal/interfaces/websocket/messages.go`.
Client schemas: `packages/sdk-core/src/effect/schemas/ws-events.ts`, `packages/sdk-core/src/effect/schemas/ws-outbound.ts`.

### Server → client message types

Core:
- `connected` (registration)
- `room.snapshot`, `room.sync`, `room.updated`
- `participant.joined`, `participant.left`, `participant.updated`
- `participant.mute`, `participant.unmute`
- `recording.started`, `recording.stopped`
- `chat.message`, `reaction`, `hand.raised`, `hand.lowered`
- `error`, `ping`, `pong`

Whiteboard:
- `whiteboard.snapshot`, `whiteboard.data`, `whiteboard.cursor`
- `whiteboard.opened`, `whiteboard.closed`
- `permission.changed`

Transcript:
- `transcript.ack`

### Client → server message types

Core:
- `chat.send`, `reaction.send`
- `hand.raise`, `hand.lower`
- `participant.mute`, `participant.unmute`
- `ping`, `pong`

Whiteboard:
- `whiteboard.update`, `whiteboard.sync`, `whiteboard.clear`, `whiteboard.cursor`
- `whiteboard.open`, `whiteboard.close`
- `permission.grant`, `permission.revoke`

Transcript:
- `transcript`

### Heartbeats + reconnect

Client behavior (baseline):
- Sends `ping` on interval; expects `pong` within timeout; reconnects with backoff
- On reconnect attempts, refresh token if `tokenProvider` exists; otherwise continue with existing token

Reference: `packages/sdk-core/src/ws-client/base.ts` + `packages/sdk-core/src/ws-client/constants.ts`.

### Whiteboard protocol notes (v1 vs v2)

Outbound `whiteboard.update` is union:
- v1: `{ elements, files?, appState?, seq }`
- v2: `{ schemaVersion: 2, sceneId, syncAll, elements, seq }`

Server state/persist logic:
- `apps/api/internal/interfaces/websocket/whiteboard_state.go`
- `apps/api/internal/interfaces/websocket/whiteboard_state_persist.go`

## Critical ID Mapping (don’t hand-wave)

We must align identity across:
- Chalk participant record (`participantId` from join response / WS)
- RTK participant identity (used for tracks, active speaker, transcripts)

Baseline mapping approach (sdk-core):
- Extracts RTK stable id from `userId` / `clientSpecificId` / `customParticipantId` and falls back to RTK peer `id`.
- Uses that stable id as `Participant.id` in app state.

Reference: `packages/sdk-core/src/room.ts` (`getRtkIds`, `mapRTKParticipant`, transcript mapping).

Native apps must ensure RTK is initialized so that RTK participants carry the stable ID we expect (ideally the Chalk `participantId`).

## Decommission Plan Notes (RN apps)

RN demo apps were hard-deleted. Kept here as “do not forget” config that mattered:

- Identity:
  - iOS bundle id: `ai.q9labs.chalk`
  - Android package: `ai.q9labs.chalk`
  - Scheme: `chalk`
- iOS Info.plist strings:
  - Camera + microphone + Bluetooth usage descriptions
  - Background modes: `audio`, `voip`
- Runtime constraints that were chosen for stability:
  - Hermes: ON
  - New Architecture: OFF
  - Reanimated: v3 line (avoid breaking worklet compatibility)
- Env contract shape:
  - `API_URL` (example `https://chalk-api.q9labs.ai`)
  - `WS_URL` (example `wss://chalk-api.q9labs.ai`)
  - `CHALK_API_KEY` (if doing api-key-to-token flow)
