# Wave 1 prompt — contract, database, and server adoption

You are executing wave 1 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.

## Mission

Give the platform its ratified Space/Episode/Participant model all the way
through the database, the Go API, the wire contracts, and server-side
adoption — one wave, so the system is never touched twice.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — the vocabulary and the banned-terms table.
- `scratchpad/space-episode-schema-design-2026-08-03.md` — the schema
  design this wave implements.
- `scratchpad/public-surface-design-2026-08-03.md` — for AccessGrant and
  the `noun.condition` error-code grammar.

## Blocked on (verify before starting)

- Nothing. The Elixir true names are ruled and recorded in `GLOSSARY.md`
  ("The five sessions, resolved"): `Live.Session` → `Live.Episode`,
  `Sessions.Coordinator` → `Episodes.Coordinator`, `Sessions.Reducer` →
  `Episodes.Reducer`, `Sessions.CommandAdmission` →
  `Episodes.CommandIntake`, `Stateholder.SessionKey` →
  `Stateholder.EpisodeKey`.

## Scope

Database:

- Squash migrations to one clean baseline in the new vocabulary
  (`spaces`, `episodes`, `space_members`, …). The `sync_v3_*` identifiers
  and the old declarative migration filename die here — they were left
  intact during the protocol renumber precisely for this squash.
- Ownership law: the Space owns what IS (identity, config, members,
  living chat + whiteboard content); the Episode owns what HAPPENED
  (per-participant attendance, one `config_snapshot` jsonb frozen at
  start, artifacts). Test for field placement: can it change after the
  Episode ends? Yes → Space, no → Episode.
- Guests are rowless (episode-scoped grants, no identity row).
- Console users/memberships are a separate bounded context — untouched.

Capabilities:

- ONE closed capability namespace: the three existing permission grids
  merge into the ratified 23-capability set.
- Default role bundles: owner = all, collaborator = publish + chat +
  draw, observer = subscribe + react. No built-in host/admin roles.
- Kill `host_exit_policy` and one-host-per-session. `endMeeting` →
  `end_episode`; promoteDemote + transferHost → `assign_roles`.

Content:

- Chat and whiteboard writes require a live Episode and are stamped with
  a non-null `episode_id`; the canonical streams belong to the Space.

Go API:

- `sessionlifecycle` becomes Episode-named; routes are plural resources
  (`/spaces/{id}`); error codes are `noun.condition` with underscores in
  the condition (`episode.not_found`).
- Split the httpapi composition god package; split room-actions across
  its four owners.
- `ParticipantAccess` → `AccessGrant` on the wire. This wave renames it
  FIRST; the SDK (wave 2) and broker (wave 5) follow. Never let a
  downstream surface rename it ahead of the wire.

Contracts and generation:

- OpenAPI, webhook v1 events, and the sync wire schema move to the new
  vocabulary (room/session → space/episode field names); regenerate the
  Elixir and TypeScript outputs.
- Rename `tools/contract-codegen` to its real, fixture-proof role.

Elixir sync adoption:

- Adopt the regenerated contract; rename room/session vocabulary
  (room_actions and friends) per the glossary. `Live.Session` and
  `Sessions.Coordinator` take their glossary-recorded true names.

Mechanical downstream compatibility ONLY:

- TypeScript client, apps, and broker get the minimal mechanical edits
  (renamed fields/types) needed to keep the whole gate green. No
  structural SDK work (wave 2), no component work (wave 3), no broker
  vocabulary work (wave 5).

## Definition of done

- Commit gate green (the pre-commit hook runs it; ~5 min).
- Language-ratchet counts fall for api/sync/tools surfaces; lock with
  `pnpm run language:ratchet:update` and stage
  `tools/language-ratchet/baseline.json` in the same commit.
- All migrations apply to a disposable Postgres; Go tests, vet,
  staticcheck pass; sync test suite passes with zero skips.
- No banned terms remain in the surfaces this wave owns.

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds; parallel
  builds race on each other's `dist/`.
- `pnpm run gate -- --full` is red for pre-existing reasons (untracked
  `private/` snapshot, other agents' unpushed commits). The per-commit
  gate is the standard; don't chase full-mode findings that aren't yours.
- Keep `.worktrees/` clean; the gate's vitest filters match stale test
  copies inside it.
