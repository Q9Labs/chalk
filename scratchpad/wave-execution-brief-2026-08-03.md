# Wave execution brief — 2026-08-03

Self-contained brief for executing the remaining rename-and-redraw waves.
Written for Hasan and whichever agent he drives them with; it assumes no
context beyond this file and the canon documents below. Claude (this
session) keeps the merge chores (done), this brief, and the marketing and
docs passes; everything else here is the executor's.

## Canon documents

Read these before any wave; they are ratified and not open for redesign:

- `GLOSSARY.md` — the vocabulary. One concept, one name, all the way down.
- `scratchpad/space-episode-schema-design-2026-08-03.md` — wave 1 design.
- `scratchpad/client-sdk-split-design-2026-08-03.md` — wave 2 design.
- `scratchpad/public-surface-design-2026-08-03.md` — the full public API
  surface: `<Chalk />` props, SpaceClient shape, Entrance, AccessGrant,
  every death and rename. Binding for waves 2 and 3.
- `scratchpad/execution-strategy-map-2026-08-03.md` — the approved order.

## State as of this brief

- Wave zero is merged to master (98968f04): legacy sync architecture
  deleted, sync protocol renumbered v3→v1 (`/v1/sync`, ProtocolV1,
  SocketV1, GeneratedV1, `state_schema_version` 1), full gate green.
- UI-primitives consolidation is merged: React SDK imports Button, Input,
  Badge, Card, Toggle, Tooltip from `@q9labsai/chalk-ui` only.
- Language-ratchet baseline is locked at the improved counts.
- The old `sdks/ubiquitous-language.md` is deleted; GLOSSARY.md is the
  only vocabulary source of truth.
- Deliberately unrenamed: DB identifiers `sync_v3_*` and the declarative
  migration filename — they die in wave 1's baseline squash, not before.

## Wave order

1. **Contract wave** — Go API + DB per the schema design sheet: squash
   migrations to a clean baseline (this is where `sync_v3_*` identifiers
   disappear); spaces/episodes/members tables; ONE capability namespace
   (23-cap closed set; bundles owner/collaborator/observer); chat and
   whiteboard writes stamped with a live `episode_id`; kill
   host_exit_policy and one-host-per-session; `noun.condition` error
   codes; console users/memberships untouched. Fold in: httpapi
   composition split, room-actions four-owner split, contract-codegen
   rename to its real fixture-proof role.
2. **Client SDK wave** — after 1 merges (it consumes the new contract).
   SpaceClient per the split design + public-surface sheets: flat
   lifecycle, controllers media/chat/participants/reactions/whiteboard
   (files under `chat.files`), internal Connection coordinator, one
   SpaceSnapshot store, `getAccess` → AccessGrant, the R1 access-refresh
   requirement, Effect-TS core with Promise public surface. Media-plane
   contract moves out of sync types into its neutral home.
3. **React/RN wave** — after 2. `<Chalk />`, `<ChalkProvider>`,
   `<Entrance />`, prebuilt components bound to the SpaceSnapshot store
   only; delete the hook/provider forwarding mirrors; RN ClientSession
   gets its true name here. **Blocked on the hook-names sheet (below).**
4. **Apps wave** — web + mobile adopt the new SDK surface and vocabulary.
5. **Infra/broker wave** ∥ 6. **Observability wave** — approved to run in
   parallel; disjoint surfaces. Broker is **blocked on the MeetingSession
   naming sheet (below)**. Observability: spans, dashboards, alerts,
   digests to the new vocabulary.

Marketing/docs (wave 7) is Claude's, running alongside.

## Cross-wave dependencies — do not reorder these

- **AccessGrant** (renamed ParticipantAccess) exists in three places:
  the wire/OpenAPI contract (`contract/generated/openapi.json` — wave 1),
  the server SDK subpath `sdks/typescript/client/src/server/` plus the
  client access-manager (wave 2), and the meeting broker
  (`infrastructure/meeting-broker` — wave 5). The wire name changes in
  wave 1; each later wave follows. Never rename it downstream first.
- The server SDK is not a separate package: it is the `server` entry of
  `@q9labsai/chalk-client`. Wave 2 owns it.
- Waves 5 and 6 may run parallel to each other but only after wave 2
  (broker mints what the SDK consumes).

## Two naming gates that need Hasan personally

Rulings land in `GLOSSARY.md` BEFORE the wave's code is written:

- Before wave 3: final React hook names (grammar is fixed in the
  glossary; the old UI-shape catalog survives in git history on the
  deleted `sdks/ubiquitous-language.md` as input).
- Before wave 5: the broker "MeetingSession" true name (it is an edge
  lease, not an Episode).

## Named so they don't silently drop

- **CI token-reach check** (no literal colors in component styles; the
  `theme` token contract) — belongs in wave 3's scope explicitly.
- **Browser E2E join smoke** after wave 2 or 3 — no browser test has run
  since the renumber (Playwright Chromium not installed locally); the
  join path has bitten production before.
- **Version/publish call** — every `@q9labsai/*` public surface breaks;
  decide the version story before wave 2 merges.
- **Docs are canon**: the quickstart Claude writes from the
  public-surface sheet is acceptance criteria — waves make the
  documented code real; the docs do not chase the code.

## Definition of done, every wave

- Commit gate green (the pre-commit hook runs the full selected gate).
- Language-ratchet counts fall, never rise; lock improvements with
  `pnpm run language:ratchet:update` and stage the baseline in the same
  commit, or the gate fails closed on the improvement itself.
- Zero glossary violations in the wave's surface; banned terms only in
  not-yet-reached surfaces.

## Environment notes (real regardless of who executes)

- Before any gate or typecheck, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds: parallel
  builds race (`rm -rf dist` in one package while another typechecks
  against it).
- `pnpm run gate -- --full` is currently red for pre-existing reasons
  unrelated to the waves: Fallow's full mode audits the untracked
  `private/` snapshot directory and other agents' unpushed commits. The
  per-commit gate is the standard; don't chase full-mode findings that
  aren't yours.
- Keep `.worktrees/` empty or clean: the gate's vitest filters match by
  substring and will run stale copies of tests inside worktrees.
- The commit-hook gate takes ~5 minutes on code changes; don't kill it.

## Boundaries with Claude's docs/marketing pass

Claude owns root `README.md`, `docs/`, `docs/store-listing.md`,
`GLOSSARY.md`, and marketing copy. Per-package READMEs belong to their
code waves. The ratchet baseline only ever decreases, so parallel work
merges cleanly.
