<!-- image:  -->

<!-- whats-new -->
## Features

- **Whiteboard collaboration feels steadier** — participants joining or leaving the whiteboard now stay in sync without unexpected flicker.

## Improvements

- **Whiteboard event handling is clearer** — remote open/close activity updates shared state directly, keeping everyone aligned in real time.

## Bug Fixes

- **Fixed whiteboard open/close signaling** — remote users opening or closing the board no longer triggers a local re-broadcast loop.
- **Prevented unexpected state swings** — whiteboard state no longer flips incorrectly when another participant starts or ends a shared board session.

## Technical Notes

- SDK Core: whiteboard manager now updates `isOpen` and participant presence directly from remote events.
- SDK React: removed remote event-driven local auto-open/close logic from `useWhiteboard` to avoid duplicate actions.
- Test coverage: added regression coverage for sync behavior in `packages/sdk-core/src/__tests__/whiteboard-manager.test.ts`.
<!-- /whats-new -->
