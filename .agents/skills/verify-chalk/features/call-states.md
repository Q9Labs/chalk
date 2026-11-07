# Call state previews

The call-states page renders every call screen state (for example six cameras, a 24-camera grid, a screen share, a board) with fake devices and no API or SFU. It checks layout and visual states quickly.

## Sub-features

- `states-index` lists every state at `/call-states.html`.
- `states-perf` renders `perf-six`, `perf-grid`, `perf-share` and `perf-board`.

## How to get to it (user POV)

- A developer opens `http://127.0.0.1:3071/call-states.html?state=<id>`. A real user never sees this page.

## Driving it with Playwright (apps/web/vite.call-states.config.ts)

Preconditions:

- Port 3071 is free. This server does not need `pnpm dev`.

- **Serve.** Run `pnpm --dir apps/web exec vite --config vite.call-states.config.ts` in a session that stays alive. Kill that process when done.
- **Open.** Go to `http://127.0.0.1:3071/call-states.html?state=perf-six`. Six `Video tile for` buttons show moving fake video.
- **Index.** Go to `http://127.0.0.1:3071/call-states.html`. A heading `Call states` and one link per state appear.
- **Proof.** Screenshot each state you check.

## Gotchas

- This page replaces the real API client with a stub. A pass here proves layout only, never a join, the SFU or Sync.
- The `verify-chalk` lane did not drive this journey.
