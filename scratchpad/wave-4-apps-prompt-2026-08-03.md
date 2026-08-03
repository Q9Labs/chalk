# Wave 4 prompt — apps

You are executing wave 4 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.

## Mission

Move the web and mobile apps onto the new public surface and vocabulary:
they become the first real consumers of `<Chalk />` and SpaceClient, and
the last places where room/meeting language survives in product code.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — vocabulary and banned terms.
- `scratchpad/public-surface-design-2026-08-03.md` — what the apps now
  consume; if an app needs something the surface doesn't offer, that is
  a finding to raise, not a reason to reach into internals.

## Blocked on (verify before starting)

- Wave 3 merged (`<Chalk />`, `<ChalkProvider>`, Entrance exist).

## Scope

- `apps/web`: adopt the new SDK surface end to end — routes and paths
  (`/room` naming → space), `chalk-access` integration through
  `getAccess`/AccessGrant, page and component names per the naming
  grammar, user-facing copy in the new vocabulary (join targets the
  Space; nobody "starts a meeting").
- `apps/mobile`: same adoption through React Native; native surfaces
  and CallKit/OS vocabulary stay vendored at adapter seams per the
  glossary.
- Local dev tooling that fronts the apps (`scripts/dev/chalk.mjs`,
  local access broker paths) follows the same vocabulary.
- Turnkey copy: finalize button labels, empty states, and Entrance copy
  with Hasan — flag strings you are unsure about rather than inventing
  product voice.

## Definition of done

- Commit gate green; web + mobile typecheck, tests, builds pass.
- Ratchet counts fall for the apps surfaces; lock with
  `pnpm run language:ratchet:update`, baseline staged in the same commit.
- No banned terms remain in app code, routes, or user-facing copy.
- The web app's join flow works in a real browser (extend the wave-3
  E2E smoke to cover the app route, not just the SDK consumer).

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds.
- `pnpm run gate -- --full` is red for pre-existing, unrelated reasons;
  the per-commit gate is the standard.
- Keep `.worktrees/` clean; gate vitest filters match stale copies.
