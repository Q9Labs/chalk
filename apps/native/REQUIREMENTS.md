# Chalk Native Apps — Requirements (apps-first)

Purpose: build production-grade native apps (`apps/ios`, `apps/android`) using Cloudflare RealtimeKit for media and Chalk backend (HTTP + WS) for product sync (chat/whiteboard/participants/reactions/recording/etc).

UI: custom. Not implemented in this doc. References in `apps/native/SPEC.md`.

## Environments / Config

- `apiBaseUrl` (e.g. `https://chalk-api.q9labs.ai`)
- `wsBaseUrl` (e.g. `wss://chalk-ws.q9labs.ai/ws`)
- `tenant` / `apiKey` (only if using API-key-to-token flow)
- `debug` flag (enables verbose logging)

## Authentication + Tokens

Native apps must treat tokens as two separate channels:

- `accessToken` (JWT): authorizes Chalk HTTP + Chalk WebSocket
- `rtcToken`: authorizes Cloudflare RealtimeKit meeting join

Acquisition:

- Preferred: your app backend provides the SDK a fresh `accessToken` + `rtcToken` for a given `roomId` + `displayName`.
- Supported fallback (parity with web): API-key-to-token provider (server issues tokens from API key); token stored securely.

Refresh:

- HTTP 401: refresh `accessToken` via `POST /api/v1/auth/refresh` (or call back to app backend) then retry.
- WS reconnect: refresh `accessToken` before reconnect if available.

## Join / Leave (happy path)

Join:

1. HTTP add participant: `POST /api/v1/rooms/:id/participants`
2. Connect Chalk WS `/ws` using `Sec-WebSocket-Protocol: chalk, token.<accessToken>`
3. Init + join RTK meeting using `rtcToken`
4. Render UI based on:
   - Participants/state: Chalk WS snapshot + deltas
   - Media tracks/screenshare: RTK events/tracks mapped to participants

Leave:

- RTK: leave meeting + stop local tracks.
- WS: close connection.
- HTTP: optional remove participant (`DELETE /api/v1/rooms/:id/participants/:pid`) depending on policy.

## Chalk WebSocket (must-have)

### Transport

- Endpoint: `GET /ws`
- Must send token via subprotocol offer list (`chalk`, `token.<jwt>`), not via query param (query is deprecated).
- Must set read limit / message size handling (server read limit exists; large whiteboard payloads possible).

### Heartbeat + reconnect

Baseline behavior (match `sdk-core`):

- Periodic `ping` outbound; `pong` inbound updates last-seen; reconnect if timed out.
- Reconnect with backoff; refresh token on reconnect if possible.
- On reconnect, request re-sync if local state is behind (`room.sync`, `whiteboard.sync`).

### Message types to implement (minimum)

Server → client:

- `connected`
- `room.snapshot`, `room.updated`
- `participant.joined`, `participant.left`, `participant.updated`
- `chat.message`, `reaction`, `hand.raised`, `hand.lowered`
- `recording.started`, `recording.stopped`
- `whiteboard.snapshot`, `whiteboard.data`, `whiteboard.cursor`, `permission.changed`, `whiteboard.opened`, `whiteboard.closed`
- `error`, `ping`, `pong`
- `transcript.ack`

Client → server:

- `chat.send`, `reaction.send`, `hand.raise`, `hand.lower`
- `whiteboard.update`, `whiteboard.sync`, `whiteboard.clear`, `whiteboard.cursor`, `whiteboard.open`, `whiteboard.close`
- `permission.grant`, `permission.revoke` (host-only)
- `transcript` (final transcripts only)
- `ping`, `pong`

Payload catalogs: `apps/api/internal/interfaces/websocket/messages.go` and `apps/native/FINDINGS.md`.

## Participants + State Model

Chalk WS participants are the authoritative roster and “product state”:

- display name, role, handRaised, (optionally) audio/video enabled flags, metadata
- recording state in room snapshot

RTK participants are authoritative for media tracks + screenshare + active speaker.

Requirement: stable participant identity across both systems so you can attach tracks to the correct Chalk participant.

- Ideal: RTK participant `userId`/`customParticipantId` == Chalk `participantId` (UUID string).
- Do not ship if this mapping is not guaranteed and tested.

## Chat / Reactions / Hand Raise

- Chat:
  - Outbound: `chat.send { content }`
  - Inbound: `chat.message { id, participant_id, display_name, content, timestamp }`
- Reactions:
  - Outbound: `reaction.send { emoji }`
  - Inbound: `reaction { participant_id, emoji, timestamp }`
- Hand:
  - Outbound: `hand.raise` / `hand.lower`
  - Inbound: `hand.raised` / `hand.lowered`

## Whiteboard Sync

Transport: Chalk WS.

Requirements:

- Must support initial sync on join: request `whiteboard.sync` and render `whiteboard.snapshot`.
- Must support live updates (`whiteboard.update` → `whiteboard.data`) + cursor presence.
- Must support file uploads via presigned URLs:
  - `presign-upload` then PUT to upload URL
  - `presign-download` then GET from download URL
- Must support permissions (`permission.changed`; host grant/revoke messages).

Note: protocol supports both v1 and v2 updates. Prefer v2 long-term (sceneId, syncAll).

### Whiteboard UI Strategy (native apps)

Decision: Excalidraw runs in a WebView. Native owns:

- Chalk WS connection + whiteboard message I/O
- Presign API calls (Chalk HTTP)
- Bridging (JSON messages) between WebView and native view-model

Web host implementation:

- `apps/native/whiteboard-web` (bundled; no CDN)
- Collab engine: `packages/chalk-whiteboard/src/collab/*`

Bridge protocol (WebView <-> native):

- Native -> WebView (call `window.__chalkNativeOnMessage(JSON_STRING)`):
  - `wb.init { canDraw, theme? }`
  - `wb.snapshot { sceneId?, elements[] }`
  - `wb.update { sceneId?, syncAll?, elements[] }`
  - `wb.cursor { participantId, displayName, x, y, timestampIso? }`
  - `wb.presignUpload.result { uploadUrl, expiresAtMs }` / `{ error }` (with `requestId`)
  - `wb.presignDownload.result { downloadUrl, expiresAtMs }` / `{ error }` (with `requestId`)
- WebView -> native (via `window.ChalkNativeBridge.postMessage(JSON_STRING)` or iOS WK handler):
  - `wb.sendUpdateV2 { schemaVersion:2, sceneId, syncAll, elements[], seq }`
  - `wb.sendCursor { x, y }`
  - `wb.requestSync`
  - `wb.sendClear`
  - `wb.presignUpload { fileId, mimeType }` (with `requestId`)
  - `wb.presignDownload { fileId }` (with `requestId`)

Hardening pitfalls (plan for them explicitly):

- CORS from WebView origin: uploads/downloads use `fetch(presignedUrl)` inside WebView. If presigned host/bucket CORS is restrictive, this can fail. If it fails, fallback plan: perform PUT/GET in native, then deliver `dataURL` into WebView (requires new bridge messages).
- Message size: `elements[]` can be large. Must avoid UI-thread JSON work; consider chunking or compression if server/client limits hit.
- Touch/stylus: validate pointer events in Android WebView + iOS WKWebView (pinch/zoom, palm rejection, Apple Pencil). Disable conflicting scroll containers around WebView.
- Reconnect: on WS reconnect, native must re-request `whiteboard.sync` and forward snapshot to WebView.
- Permissions: when `permission.changed` toggles `canDraw`, WebView must immediately switch between edit and view-only.

## Recording

Control: Chalk HTTP.

- Start: `POST /api/v1/rooms/:id/recordings/start`
- Stop: `POST /api/v1/rooms/:id/recordings/stop`

State:

- Observe `recording.started|stopped` over WS + `isRecording/recordingId` in room snapshot.
- Retrieve: `GET /api/v1/recordings/:id` and `GET /api/v1/recordings/:id/download`

UX constraints:

- Avoid start/stop within ~5 seconds (short recordings can error).
- Show clear recording indicator + host-only controls.

## Screen Sharing

Transport/control: RTK (not Chalk WS).

Requirements:

- Start/stop local screenshare using RTK APIs.
- Surface remote screenshare tracks in UI and map to correct participant.
- iOS: ReplayKit extension + app group plumbing (high-risk area; test early).
- Android: MediaProjection flow + foreground service if required.

## Transcripts (persistence)

Source: RTK transcript stream.

Requirements:

- Emit interim transcripts to UI (optional).
- Persist final transcripts to backend via WS `transcript` message.
- Handle `transcript.ack`.

## Non-functional

- Stability: reconnection without app restart; survives background/foreground.
- Security: never log `accessToken` or `rtcToken`; avoid query-param auth in WS.
- Observability: structured logs + session context (roomId, participantId, tenantId).
- Performance: avoid blocking UI thread during decode/encode and large whiteboard payload handling.

## “Ready to Extract SDK” Definition

Do not start SDK extraction until:

- Both apps implement the protocol correctly (HTTP + WS + RTK).
- Participant identity mapping is proven across join/reconnect.
- Whiteboard sync is stable under multi-user concurrent editing.
- Recording start/stop + download flow works end-to-end.
- Screen share works on real devices (iOS extension included).
