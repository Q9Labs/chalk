# Whiteboard

Two people in a call open the shared board, draw with the pen, and both see the strokes. The board follows the presenter's view until someone chooses `Stop`.

## Sub-features

- `board-open` opens the board with the `Board` button.
- `board-draw` draws a stroke with `Drawing tools` then `Pen`.
- `board-sync` shows one person's strokes on the other's board.
- `board-follow` follows the presenter (`Follow` and `Stop following` menu items, `Stop` button).
- `board-zoom` zooms with `Zoom in` and `Fit to content`.

## How to get to it (user POV)

- In a call, choose `Board` in the stage controls.

## Driving it with Playwright (tests/board.e2e.ts)

Preconditions:

- Two participants named `BoardA` and `BoardB` are in the same call. Join them as in [join-call.md](./join-call.md), or follow `joinBoardParticipants` in `tests/board.e2e.ts`.
- The page can load the self-hosted Excalidraw assets (the Vite web server serves them).

- **Open.** On page A click `getByRole("button", { name: "Board", exact: true })`. The element `.chalk-board[data-ready]` appears in the primary stage item on both pages.
- **Stop following.** On page B click `getByRole("button", { name: "Stop", exact: true })`.
- **Draw.** Click `Drawing tools` if `Pen` is hidden, click `Pen`, then press the mouse at one point in the board box and move with `steps: 12` to another. `.chalk-board` has `data-elements="1"` after one stroke.
- **Sync.** After two strokes, `.chalk-board` shows `data-elements="2"` on both pages and canvas pixels at both stroke positions are drawn.
- **Proof.** Screenshot both pages and read `data-elements` on both.

## Gotchas

- The whiteboard WebSocket (`/v1/whiteboard`) is Sync's. A dev stack behind one public origin (an Orb) must proxy it to Sync as it does `/v1/sync` (`apps/web/vite.config.ts`), or the `Board` button never appears.
- `tests/board.e2e.ts` creates its own Space through `/space/` and targets `CHALK_PROOF_WEB_URL`. Set that variable to the local web origin to run it against this stack. It needs the same SFU credentials as a call.
- Wait for the stage animations to settle before you measure pixels. The spec's `settleStage` shows how.
- `.agents/skills/verify-chalk/scripts/board-draw.mjs` drives this journey with a host who started the call and a guest who joined by its link; the steps come from the spec.
