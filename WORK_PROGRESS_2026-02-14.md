# Work Progress (2026-02-14)

## 2026-02-14 00:00
- Task: websocket robustness: error-handling, logging+tracing (API+SDK), UI toasts for user-reportable errors, Axiom logging in SDK.
- Constraint: discovery + analysis only before implementation; keep notes here; discuss plan with Hasan before code changes.

## 2026-02-14 00:06
- Repo scan:
  - SDK-Core already has `WSClient` + schema-first ws-client folder: `packages/sdk-core/src/ws-client/*`.
  - SDK-Core has “wide events” incl `websocket.connect|disconnect|reconnect`: `packages/sdk-core/src/wide-events/types.ts`.
  - API already wired to Axiom (`axiom-go` + slog adapter) + OTEL exporter to Axiom traces dataset:
    - logging: `apps/api/internal/infrastructure/logging/logger.go`
    - tracing: `apps/api/internal/infrastructure/otel/otel.go`
    - websocket endpoint: `apps/api/internal/interfaces/http/handlers/websocket.go` mounted at `GET /ws`
    - ws hub/client logs: `apps/api/internal/interfaces/websocket/hub.go`, `apps/api/internal/interfaces/websocket/client.go`
  - Existing ws test coverage in SDK-Core: `packages/sdk-core/src/__tests__/ws-client.test.ts`, `packages/sdk-core/src/__tests__/room.test.ts`.
  - Toast usage spotted in web UI: `packages/sdk-react/src/components/full/MeetingRoom.tsx` (invite toast); likely extend this pattern for ws-sync error toasts.

## 2026-02-14 00:18
- API WS handler (`apps/api/internal/interfaces/http/handlers/websocket.go`):
  - Auth token via `Sec-WebSocket-Protocol: token.<jwt>` (query param fallback deprecated).
  - Logs `websocket.presence` + `websocket.upgrade_ok` including `local_room_clients` and DB `expected_active_participants` for split-brain detection.
  - Hydrates participant metadata from DB on this instance (WS may land on different instance than HTTP join).
  - Registers hub client + starts pumps on `context.Background()` (good: upgrade ctx would cancel).
- API WS client (`apps/api/internal/interfaces/websocket/client.go`):
  - `SendReliable` closes slow clients on backpressure with close code `1008` + `reason=backpressure`.
  - Logs canonical `websocket.error` kinds: `read|write|ping|invalid_message|unknown_message_type`, plus `websocket.app_error` when server sends MessageType `error`.
  - Noted code duplication smells (duplicate `case MessageTypeWhiteboardCursor`, etc) worth sanity-checking later.
- API WS hub (`apps/api/internal/interfaces/websocket/hub.go`):
  - Emits periodic `ws.metrics` wide log line (drops, enqueued, backpressure closes, write/ping errors).
  - Has Redis pubsub helpers `SubscribeToRoom` + `PublishToRedis`, but `PublishToRedis(...)` appears unused outside its definition (rg confirms).
  - Join/leave fanout in `registerClient/unregisterClient` uses `BroadcastToRoom(...)` only (local instance only).
  - File also shows duplication artifacts in the snippet (double `if`, duplicated loops) -> likely real and could hide logic bugs.
- SDK-Core WSClient (`packages/sdk-core/src/ws-client/base.ts`):
  - Uses `Sec-WebSocket-Protocol` with `["chalk", "token.<accessToken>"]` which matches API parsing.
  - Heartbeat timer checks last `pong`; reconnect backoff; emits `MAX_RECONNECT_ATTEMPTS` error.
  - Observed bug: `onclose` emits `disconnected` twice (needs fix later).
- SDK-Core observability:
  - Wide events already support custom handler (`packages/sdk-core/src/wide-events/*`) and won’t crash SDK if handler throws (errors swallowed).
  - This is the clean seam to add “Axiom logging in SDK” without sprinkling logs everywhere.
- SDK-React UI:
  - Already has copyable toast pattern (screenshare failure) in `packages/sdk-react/src/components/full/VideoConference.tsx`.
  - Meeting ends on `session.on("disconnected")` even if “disconnected” is transient; could explain “joins then meeting ends”.

## 2026-02-14 11:58
- Web: set HTML `Cache-Control` to `max-age=0, s-maxage=0, must-revalidate` to avoid stale entrypoints referencing deleted hashed chunks.
