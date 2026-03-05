# SDK Refactor Tracker (2026-03-05)

Status model:
- `active` = approved to execute now
- `pending-approval` = do not start until Hasan approves
- `done` = completed and verified

## Queue

1. `done` — [packages/sdk-react/src/components/full/WhiteboardPanel.tsx](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/WhiteboardPanel.tsx)
2. `active` — [packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/video-conference/useJoinFlow.ts)
3. `active` — [packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/video-conference/useSessionEvents.ts)
4. `active` — [packages/sdk-react/src/components/full/EndScreen.tsx](/Users/macmini/Desktop/Code/chalk/packages/sdk-react/src/components/full/EndScreen.tsx)
5. `pending-approval` — [packages/sdk-core/src/client.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/client.ts)
6. `pending-approval` — [packages/sdk-core/src/room.ts](/Users/macmini/Desktop/Code/chalk/packages/sdk-core/src/room.ts)

## Execution rule (requested by Hasan)

- Work now: `1-4`
- Hold: `5-6` until explicit approval

## Progress

- `2026-03-05`: `#1 WhiteboardPanel` refactor pass completed (runtime hooks extracted, UI shell simplified, behavior preserved, checks/tests green).
