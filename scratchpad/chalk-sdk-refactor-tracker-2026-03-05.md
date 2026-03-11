# SDK Refactor Tracker (2026-03-05)

Status model:

- `active` = approved to execute now
- `pending-approval` = do not start until Hasan approves
- `done` = completed and verified

## Queue

1. `done` — [packages/sdk-react/src/components/full/WhiteboardPanel.tsx](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/WhiteboardPanel.tsx)
2. `done` — [packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts)
3. `done` — [packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts)
4. `done` — [packages/sdk-react/src/components/full/EndScreen.tsx](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/EndScreen.tsx)
5. `done` — [packages/sdk-core/src/client.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/client.ts)
6. `done` — [packages/sdk-core/src/room.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/room.ts)

## Execution rule (requested by Hasan)

- Work now: `1-6`
- Hold: none

## Progress

- `2026-03-05`: `#1 WhiteboardPanel` refactor pass completed (runtime hooks extracted, UI shell simplified, behavior preserved, checks/tests green).
- `2026-03-05`: `#2 useJoinFlow` refactor completed (preload/telemetry/device-selection helpers extracted; hook reduced to orchestration).
- `2026-03-05`: `#3 useSessionEvents` refactor completed (error classification + diagnostic payload logic extracted; event wiring simplified).
- `2026-03-05`: `#4 EndScreen` refactor completed (feedback/download/actions split into focused modules; shell slimmed).
- `2026-03-05`: `#5 client.ts` completed with naming overhaul (`ChalkClient` -> `ConferenceClient`, `joinRoom/createRoom/endRoom` -> `joinSession/createSession/endSession`, session-first getters/state naming) and downstream package alignment.
- `2026-03-05`: `#6 room.ts` completed with event contract redesign (`ConferenceSessionEvents` + dot notation), class rename (`Room` -> `ConferenceSession`), and cross-manager/service/test listener migration.
- `2026-03-05`: `#5 client.ts` full structural composition pass completed. Introduced `conference-client/config.ts`, `conference-client/join-session.ts`, and `conference-client/rtk-runtime.ts`; `ConferenceClient` now acts as orchestrator with explicit module seams.
- `2026-03-05`: `#6 room.ts` full structural composition pass completed. Introduced `conference-session/*` modules for media/device/interaction/whiteboard/leave/signaling flows; `ConferenceSession` now composes these modules instead of embedding all behavior inline.
- `2026-03-05`: compatibility seam restored for existing internal test hooks (`_initRealtimeKitEffect`, `_joinRealtimeKitWithRetry`, `_joinRealtimeKitEffect`, `isTokenExpired`, RTK preload/import cache path), preserving resilience and telemetry test coverage after modularization.
- `2026-03-05`: verification complete after composition pass: `packages/sdk-core` (`check-types`, `test`), `packages/sdk-react` (`check-types`, `test`), `packages/sdk-react-native` (`check-types`, `test`) all green.
- `2026-03-05`: breaking auth-event rename complete across touched SDK surfaces: `token-expired` and `token:expired` removed in favor of canonical dot notation `token.expired`, with core/RN listeners + tests updated and gates green.
- `2026-03-05 19:43 PKT`: triaged `apps/web` room-route `HTTPError`/500 report. Reproduced HTML-vs-JSON request mode behavior, validated SDK join path, and hard-stabilized room entry transitions to force document navigation (`/demo`, `/j/$joinToken`, `/room/error` retry, `/room/end` rejoin) so room boot no longer depends on TanStack data-request mode.
- `2026-03-06 00:08 PKT`: produced `sdk-core` variant decision report (`scratchpad/chalk-sdk-variant-decision-report-2026-03-06.md`) with canonical picks: keep `token.expired`, keep whiteboard wire v2 as outbound canonical, keep dot-notation WS contracts, keep `token/tokenProvider` auth (deprecate `apiKey`).
- `2026-03-07`: phase-A follow-up verified: `token.expired` dot-notation now canonical in client/session/api paths; dead `whiteboardSyncV2` toggle removed from provider/session surfaces; `apiKey` now explicitly `@deprecated` in provider/session configs; `bun run check-types` green across workspace. Current compatibility note: whiteboard v1 outbound send path still active in `WhiteboardManager.sendUpdate` while inbound supports schema v1+v2.
- `2026-03-07`: API protocol check complete (`apps/api` websocket). Whiteboard wire is v2-canonical (`schema_version=2`, scene epoch model, v2 snapshots/persistence), with explicit v1 inbound fallback in `handleWhiteboardUpdate` that upconverts to internal v2 before fanout.
- `2026-03-07`: readiness audit verdict: whiteboard v2 is functional but not full production-parity replacement for v1 yet. Blockers include server-side permission enforcement gaps, v1 fallback clear-resurrection risk, and appState/files parity gaps on sync/persistence. See API websocket client + whiteboard_state(\_persist) and sdk-react whiteboard sync seams.
- `2026-03-07`: v2 hardening pass (in progress complete slice): API websocket now enforces whiteboard draw access and tenant host-override policy, rejects legacy v1 `whiteboard.update` payloads (`schema_version=2` required), and SDK v2 snapshot path now applies `appState` in collab engine; core whiteboard manager outbound sends now use v2 (`sceneId`-aware). Verification: `go test ./internal/interfaces/websocket ./internal/interfaces/http/handlers`, `bun run --cwd packages/sdk-core test`, `bun run check-types` all green.
- `2026-03-07 12:15 PKT`: v2 completion pass landed. Removed remaining whiteboard v1 protocol seams across `sdk-core`/`sdk-react`/`chalk-whiteboard`/`apps/api`: deleted legacy send API (`sendWhiteboardUpdate`), removed React `useV2`/`SyncEngine` branches, tightened SDK whiteboard schemas/types to required v2 fields, normalized API whiteboard data/snapshot payload structs to required v2 fields, and removed API v1 persisted-state restore fallback. Verification green: `bun run lint`, `bun run check-types`, `bun run test`, `bun run --cwd apps/docs build`, `cd apps/api && go test ./internal/interfaces/websocket ./internal/interfaces/http/handlers`.
- `2026-03-07 07:23 PKT`: follow-up dead-code purge completed. Removed unused `chalk-whiteboard` root v1-oriented artifacts (`src/sync-engine.ts`, `src/types.ts`), switched package-root exports to collab-v2 types, tightened collab remote handlers to require `sceneId` + `syncAll`, rewired sdk-core whiteboard `AppState` imports to `@q9labs/chalk-whiteboard/collab`, and normalized API websocket internal update type naming (`WhiteboardUpdateV2Payload` -> `WhiteboardUpdatePayload`) while retaining strict `schema_version=2`. Verification green: `bun run lint`, `bun run check-types`, `bun run test`, `bun run --cwd apps/docs build`, `cd apps/api && go test ./internal/interfaces/websocket`.
