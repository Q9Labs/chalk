# Wave 3 prompt — React and React Native

You are executing wave 3 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.

## Mission

Ship the ratified three-rung public surface in React and React Native:
`<Chalk />` (the complete turnkey experience) over `<ChalkProvider>` +
hooks over the framework-agnostic SpaceClient — and kill every legacy
prop, mirror, and name on the way.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — vocabulary; `<Chalk />`, Entrance, SpaceClient entries.
- `scratchpad/public-surface-design-2026-08-03.md` — the complete
  `<Chalk />` prop surface and the deaths table. This is the contract.
- The deleted `sdks/ubiquitous-language.md` (in git history) — its UI
  shape catalog is reference input only.

## Blocked on (verify before starting)

- Wave 2 merged (SpaceClient + SpaceSnapshot store exist).
- Hasan's rulings recorded in `GLOSSARY.md` for: final React hook names,
  and the RN ClientSession true name.

## Scope

`<Chalk />` (replaces VideoConference; a full name, not a prefix):

- Props per the public-surface sheet: `space`, `getAccess`,
  `entrance?: boolean`, `defaults?: { microphone?, camera? }`, one
  `features` object, `theme`, `layout` (controlled-optional), and the
  ratified event callbacks (`onJoined`, `onLeft`, `onEpisodeEnded`, …).
- Dead, never to return: `className`/`containerClassName` (theme is the
  only styling door), controlled `phase`, `role`, and all nine `can*`
  booleans — UI renders from snapshot capabilities via `can(capability)`.
- Deaths: roomId→space, userName→displayName, meetingLink→inviteLink,
  roomName→spaceName, onSessionEnded→onEpisodeEnded,
  onLeave+onClose→onLeft, PreJoinScreen→Entrance.

`<Entrance />`:

- One place for both pre-live states: name/device setup with
  self-preview AND knock-admission waiting. There is no lobby, green
  room, or pre-join anywhere — not in symbols, copy, or comments.

Provider and hooks:

- `<ChalkProvider>` + hooks bind to SpaceSnapshot slices only — never to
  client internals or Effect types. Delete the layered forwarding
  mirrors (sync mirror → session forwards → hook hand-mirroring); one
  command must never require four synchronized edits again.
- Hook names exactly as ruled in the glossary.

Interior tree:

- Platform-named per the naming grammar: SpaceView, Stage, Entrance,
  ChatPanel, SettingsDialog, … — shape suffix states the form, no
  `Chalk*` symbols inside the tree.
- UI primitives come from `@q9labsai/chalk-ui` only (already
  consolidated); no local duplicates.

Theme:

- `theme` is a closed typed token set emitted as CSS custom properties.
- Build the CI token-reach check THIS wave: no literal colors in
  component styles; the gate fails on violations. The token LIST may
  still grow from Hasan's UI pass — the mechanism and check ship now.

React Native:

- Same model bound to the same store; ClientSession takes its
  glossary-recorded true name; embedded whiteboard and native surfaces
  follow the naming grammar.

## Definition of done

- Commit gate green; react + react-native typecheck, tests, builds,
  publint, attw pass.
- Ratchet counts fall for the react/react-native surfaces; baseline
  staged in the same commit.
- `VideoConference`, `PreJoinScreen`, and every deaths-table name are
  gone from both packages.
- One browser E2E join smoke passes against the new surface (install
  Playwright Chromium if missing) — no browser test has run since the
  protocol renumber, and the join path has bitten production before.

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds.
- `pnpm run gate -- --full` is red for pre-existing, unrelated reasons;
  the per-commit gate is the standard.
- Keep `.worktrees/` clean; gate vitest filters match stale copies.
