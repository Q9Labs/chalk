# Chalk verification map

This directory is the maintained source for verifying the user-facing behavior of the Chalk web app. Read the index before you drive the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch with `pnpm dev` as described in [SKILL.md](../SKILL.md) and require `pnpm dev:doctor` to report `"ok": true`.
- The launcher seeds one tenant and one Space with the `cf_sfu` media plane and an enabled public invite. Its path is `invite.path` in .private/chalk-dev/seed.json.
- The seeded user is a guest. Chalk has no password accounts in this flow: a person arrives through the invite, types a name and joins.
- Run Chromium with the fake camera and microphone from `scripts/web-proof/media.mjs` (`webMediaFixture(<n>)` as a context init script). Give each participant its own browser context and fixture number.
- Use `localhost` or HTTPS as the web origin. The guest cookie is `Secure`.
- Never drive a runtime this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer ARIA roles and accessible names over CSS selectors or DOM position. Use `exact: true` on names.
- Stage controls hide until you hover the region named `Space stage`. Hover it before every control click.
- Treat quoted names as literal. `Video tile for <name>` is the accessible name of a participant's tile.
- Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Video proof means the decoded frame count of the remote tile increases between two reads at least three seconds apart.
- Mutation proof includes a second view: read the Episode's attendance from the API with the system token from the seed.
- Record the feature ID and entry point with every artifact in result.json.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with <harness>`, `Gotchas`.

## Features

- [Join a call by invite](./join-call.md) covers arriving through the invite link, the entrance screen, publishing and receiving video through the SFU, attendance and leaving. Proven by `.agents/skills/verify-chalk/scripts/join-call.mjs`.
- [Call controls](./call-controls.md) covers microphone, camera, leave and rejoin on the stage.
- [Whiteboard](./whiteboard.md) covers opening the board in a call, drawing and fitting to content.
- [Start a Space as a guest](./start-space.md) covers the `/space/` entry that creates a new Space without an account.
- [Call state previews](./call-states.md) covers the `apps/web/call-states.html` fixture for layout checks without an API or SFU.
