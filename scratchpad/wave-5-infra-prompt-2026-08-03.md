# Wave 5 prompt — infrastructure and broker

You are executing wave 5 of the Chalk vocabulary-and-boundary restructure.
This prompt is self-contained; assume no other conversation context.
May run in parallel with wave 6 (observability) — surfaces are disjoint.

## Mission

Take the new vocabulary all the way down through the edge and
infrastructure: the meeting broker loses the meeting, AccessGrant
completes its journey, and env vars, stack names, and deploy configs
stop speaking the old language.

## Read first (binding, not open for redesign)

- `GLOSSARY.md` — vocabulary; especially the entry Hasan's broker naming
  ruling adds (see Blocked on).
- `scratchpad/public-surface-design-2026-08-03.md` — AccessGrant seam.

## Blocked on (verify before starting)

- Wave 2 merged (the SDK the broker fronts speaks AccessGrant).
- Hasan's ruling, recorded in `GLOSSARY.md`, for the broker
  "MeetingSession" true name. It is an edge lease — a short-lived
  brokered claim on media infrastructure — NOT an Episode; do not
  collapse the two.

## Scope

- `infrastructure/meeting-broker`: rename the package, its
  `meeting-session.ts` lease concept (per the ruling), contracts, HTTP
  surface, and internal vocabulary. Adopt AccessGrant fully — the wire
  (wave 1) and SDK (wave 2) already renamed it; the broker is the last
  holder of ParticipantAccess.
- Infrastructure configs: env var names, worker/stack names, deploy
  scripts, `wrangler`/IaC identifiers. Names go all the way down — env
  vars and stack names are not exempt. Coordinate renames that require
  a deploy-time cutover (secrets, bound service names) with Hasan
  before merging, and list them explicitly in your report.
- Vendored vocabulary (Cloudflare SFU terms, WebRTC track) stays foreign
  at adapter seams per the glossary.

## Definition of done

- Commit gate green; broker typecheck + tests pass.
- Ratchet counts fall for the infrastructure surfaces; baseline staged
  in the same commit.
- `MeetingSession`, `ParticipantAccess`, and meeting-\* naming are gone
  from infrastructure code and config.
- Anything requiring a production cutover (renamed secrets, stacks,
  service bindings) is enumerated in the final report with a cutover
  order — renames that brick a deploy if applied blind are called out.

## Environment notes

- Before typechecks or the gate, build the library chain sequentially or
  `packages/ui` fails on missing dists:
  `pnpm --filter '@q9labsai/chalk-assets...' --filter '@q9labsai/facehash...' --filter '@q9labsai/chalk-ui...' --filter '@q9labsai/chalk-whiteboard...' --filter '@q9labsai/chalk-client...' --filter '@q9labsai/chalk-react...' --filter '@q9labsai/chalk-react-native...' --workspace-concurrency=1 run build`
- Keep `--workspace-concurrency=1` on workspace-wide builds.
- `pnpm run gate -- --full` is red for pre-existing, unrelated reasons;
  the per-commit gate is the standard.
- Keep `.worktrees/` clean; gate vitest filters match stale copies.
