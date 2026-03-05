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
