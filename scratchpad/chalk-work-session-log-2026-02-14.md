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

## 2026-02-14 00:24

- Architecture call (Hasan): 3 API instances on ECS/EC2; current WS hub is effectively single-instance -> split-brain.
- Web research:
  - Axiom JS logging supports `@axiomhq/logging` transports:
    - `AxiomJSTransport` (direct, requires token in runtime)
    - `ProxyTransport` (recommended for browser; avoid exposing Axiom token client-side)
- Redis Pub/Sub is fire-and-forget; messages not persisted (use Streams if durability required).

## 2026-02-14 00:28

- Decision: use Redis Pub/Sub for cross-instance WS fanout (ECS: 3 tasks).
- Clarified patterns:
  - "local broadcast + publish": deliver immediately to local room clients, then publish to Redis for other instances; subscribers must ignore same-origin to avoid double-delivery.
- "publish-only": publisher publishes to Redis, every instance (including origin) delivers via subscriber; simplest, slightly higher latency.

## 2026-02-14 00:32

- Decision: "local broadcast + publish" with idempotency.
- Plan for duplicates:
  - PubSub envelope includes `origin_instance_id` + `message_id`.
  - Subscriber path: ignore `origin_instance_id == this_instance_id`.
  - Safety net: keep a small TTL dedupe set for `message_id` (bounded map/LRU, per-hub).

## 2026-02-14 00:36

- Added requirement: API Axiom wide-event logs must include new pubsub correlation fields.
- Proposed new standard fields (WS + pubsub):
  - `instance_id` (always)
  - `origin_instance_id` (pubsub envelope)
  - `message_id` (pubsub envelope)
  - `delivery` (`reliable|volatile`)
  - `payload_bytes`
  - existing: `tenant_id`, `room_id`, `participant_id`, `close_code`, `close_reason`, `disconnect_by`, `error_kind`

## 2026-02-14 00:48

- Implemented API cross-instance WS fanout:
  - Added `logging.InstanceID()` (`apps/api/internal/infrastructure/logging/instance_id.go`).
  - Added Pub/Sub envelope + in-memory dedupe (`apps/api/internal/interfaces/websocket/pubsub.go`).
  - Hub now:
    - maintains per-room subscription lifecycle (start on first local client; stop on last).
    - broadcasts locally + publishes envelope to Redis for reliable/volatile sends.
    - subscriber ignores same-origin + dedupes by `message_id`.
    - logs include `instance_id` and pubsub correlation fields.
  - Client broadcasts switched to hub fanout methods; added server handling for `room.sync` (responds with `room.snapshot`).
  - WS handler base attrs now include `instance_id` (`apps/api/internal/interfaces/http/handlers/websocket_log.go`).

## 2026-02-14 01:05

- SDK changes:
  - WS reconnect now requests `room.sync` after reconnect (`packages/sdk-core/src/ws-client/base.ts`).
  - Added outbound schema + helper method `requestRoomSync(...)` (`packages/sdk-core/src/effect/schemas/ws-outbound.ts`, `packages/sdk-core/src/ws-client/client.ts`).
  - WS max-reconnect error now includes diagnostic details; Room forwards WS error details (`packages/sdk-core/src/ws-client/base.ts`, `packages/sdk-core/src/room.ts`).
  - Added Axiom wide-events handler helper + `ChalkClientConfig.axiom` option to auto-wire (`packages/sdk-core/src/wide-events/axiom.ts`, `packages/sdk-core/src/client.ts`, `packages/sdk-core/src/types.ts`).
  - React SDK now shows copyable toast for WS errors (rate-limited) and includes `wideEvents.sessionId` (`packages/sdk-react/src/components/full/VideoConference.tsx`).

## 2026-02-14 01:12

- Gate results:
  - `bun run lint` OK
  - `bun run check-types` OK
  - `bun run test` OK (added `MutationObserver` polyfill in `packages/sdk-react/src/__tests__/setup.ts`)
  - `go test ./...` OK (fixed nil PubSub guard in `apps/api/internal/interfaces/websocket/hub.go`)

## Plan (Proposed) — WS Robustness + Observability

### Goals

- Cross-instance WS fanout correctness (3 ECS tasks) via Redis Pub/Sub per room.
- No silent failures: structured logs + traces (API) + wide events (SDK).
- Human-readable + copyable UI errors (toast) for WS sync failures.
- Axiom logging from SDK via `wideEvents.handler` (proxy; never expose Axiom token in browser).
- Add new correlation fields to API wide-event logs (Axiom) for WS + pubsub debugging.

### API: Redis Pub/Sub Fanout (apps/api)

1. Pub/Sub envelope type (JSON):
   - `message_id` (uuid)
   - `origin_instance_id` (boot-id)
   - `room_id`
   - `exclude_participant_id` (optional)
   - `delivery` enum: `reliable|volatile`
   - `data` (raw WS payload; encode choice TBD)
2. Hub instance identity:
   - generate `instance_id` at boot (hostname+pid or random uuid)
3. Room subscription lifecycle:
   - per-room refcount local clients
   - on first join: start `SubscribeToRoom(ctx, roomId)` goroutine
   - on last leave: cancel subscription ctx + cleanup maps
4. Publishing path:
   - for room events: local broadcast immediately + publish envelope to Redis
5. Subscriber path:
   - decode envelope
   - drop if `origin_instance_id == this.instance_id`
   - dedupe `message_id` via small TTL/LRU map (in-memory)
   - broadcast locally via `delivery`:
     - `reliable`: `SendReliable`
     - `volatile`: `Send`
6. Implement `room.sync` server handling:
   - client sends `room.sync`
   - server responds to requester with fresh `room.snapshot` (reliable)
7. Logging/tracing tightening:
   - add pubsub fields: `message_id`, `origin_instance_id`, `delivery`, `payload_bytes`
   - log subscribe start/stop per room, publish errors, decode errors
   - add `instance_id` to all WS logs (connect/disconnect/error/app_error/presence/ws.metrics/ws.redis.\*)
   - add `message_id` where available to `websocket.disconnect` (if close triggered by pubsub backpressure) + any “broadcast” wide events we add
8. Code hygiene (surgical):
   - fix obvious duplication/typos in `hub.go`/`client.go` while editing (no drive-by refactors)

### SDK-Core: WS Error + Axiom Hook (packages/sdk-core)

1. Fix WSClientBase bug: `onclose` emits `disconnected` twice.
2. Expand WS error surface:
   - include close code/reason/wasClean, reconnectAttempt, lastPongAgeMs in emitted errors.
   - map common close reasons to stable Chalk error codes (for UI).
3. Wide events: optional “Axiom wideEvents handler” helper:
   - Node/server: direct ingest ok (token env)
   - Browser: proxy transport only
4. Sync-heal:
   - on connect: wait for `connected` + first `room.snapshot`; if timeout emit recoverable error
   - on reconnect: request `room.sync` once connected
5. Tests:
   - unit test: single `disconnected` emission
   - unit test: `room.sync` sent on reconnect (mock timers/ws)

### SDK-React: User-Reportable Toasts (packages/sdk-react)

1. Reuse existing copy-toast pattern (screenshare) for WS errors:
   - “Copy error” action; payload includes: debugId, roomId, participantId, wideEvents.sessionId, ws close info, timestamps, UA/url.
2. Meeting end behavior:
   - do not auto-end meeting on WS-only disconnect if RTK still connected
   - only end on explicit leave / RTK roomLeft / hard-failed connection (policy to confirm)

### Rollout/Verify

1. Local dev: run 2 API instances + shared Redis; confirm cross-instance join/leave/chat/whiteboard/moderation.
2. Prod smoke (Axiom):
   - `websocket.presence` mismatch should drop
   - `ws.redis.*` subscribe/publish error rates
3. Runbook snippet: where to look in Axiom; which fields to filter on.

### Open Questions (need your call)

- PubSub payload encoding: decided JSON (`json.RawMessage`), no base64.
- Meeting end policy: decided end only on RTK disconnect; never on WS-only disconnect.
- WS reconnect requirement: WSClient should auto-reconnect; on reconnect trigger `room.sync` to heal state drift.

## 2026-02-14

- 13:56:52Z API CI/CD run `22018520205` -> `success` (Deploy to ECS + Health Check succeeded)
- 13:48:28Z Web CI/CD run `22018520195` -> `success` (Cloudflare Pages deploy)
- 13:48:28Z SDK CI/CD run `22018520198` -> `skipped` (workflow config: tag/manual only)
- 2026-02-14T14:23:35Z transcription default provider: prefer `whisper` when available; fallback `groq` (fix domain defaults + docs examples)
- 2026-02-14T14:41:32Z API CI/CD run `22019111734` -> `success` (default transcription provider prefer whisper)
