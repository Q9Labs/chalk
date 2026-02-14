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

## 2026-02-14 10:23
- Web: dashboard UI overhaul (table + stats + search + actions). Redeploy triggered.
