# Chalk

Ultra low-latency video conferencing built on Cloudflare RealtimeKit. This is a
monorepo for the public SDK packages, demo apps, docs, and selected support
tooling.

## Commands

```bash
pnpm install
pnpm dev
pnpm build
pnpm test
pnpm lint
pnpm check-types
```

## Quality Gate

- `pnpm run gate` is the canonical pre-remote quality contract for agents and
  humans. Run it before asking for a commit, PR, or deployment.
- `pnpm run gate:explain` prints the gate script descriptions and hook
  behavior.
- Hooks are non-mutating: do not rely on them to format, fix, stage, regenerate,
  stash, reset, or revert files.
- Go API work under `apps/api` has its own focused gate:
  `apps/api/scripts/gate.sh`. Run it after touching Go API code. It uses an
  explicit patched Go toolchain, checks formatting without mutating, and runs
  tests, `go vet`, Staticcheck, and `govulncheck`.

## Database Migrations

- Treat DB schema changes as release blockers.
- If code or generated queries reference new columns, tables, or indexes, apply
  and verify the matching migrations before closing the change.
- Keep checked-in SQL migrations and embedded API startup migrations in sync.
- Prefer automated migration and post-deploy verification over manual-only
  deployment notes.

## Testing

- Add or update focused automated tests for behavior changes.
- For UX changes, verify the flow in a real browser in addition to automated
  coverage when the local app can exercise it.
- Keep user-facing product language role-neutral unless an integration requires
  a specific domain vocabulary.

## Comments

- Add comments when they explain why a boundary, invariant, workaround, or
  non-obvious tradeoff exists. Avoid comments that merely restate what the code
  says.
- Treat a needed explanatory comment as a design checkpoint: if the comment
  reveals duplication, hidden coupling, or an awkward abstraction, either improve
  the shape or leave a concise note about the constraint.
- For Go API code, follow the local standards in
  `apps/api/docs/code-standards.md`.

## Where To Write Code

Packages are the source of truth; demo apps should stay thin.

- `packages/sdk-core`: client logic, room management, transport integration,
  auth helpers, shared types, diagnostics, webhooks.
- `packages/sdk-react`: React hooks and components.
- `packages/sdk-react-native`: React Native hooks, components, and native
  bridges.
- `packages/chalk-whiteboard`: whiteboard collaboration features.
- `packages/ui`: shared UI primitives.
- `apps/web`: Chalk web app and local verification surface.
- `apps/docs`: public documentation.
- `apps/mobile`: native demo and release verification app.
- `apps/api`: Go control-plane API. Keep `cmd/main.go` thin; put router,
  response helpers, middleware, and domain packages under `internal/*`. Follow
  `docs/redesign/north-star.md`: composable hexagonal boundaries, swappable
  `MediaPlane` / `SyncEngine` ports, provider details in adapters, and public
  REST routes under one `/v1` boundary while operational routes like `/healthz`
  stay unversioned. First API patterns are being designed manually before
  broader endpoint fill-in.
- `infrastructure`: deployable support tooling that remains after the API and
  Terraform teardown.

For product behavior, networking, auth, observability, SDK APIs, retries,
diagnostics, or error handling, implement the owned package first and wire demo
apps afterward. Avoid app-only fixes when package code should own the behavior.

## Public Repo Hygiene

- Do not commit raw logs, screenshots, generated debug artifacts, local temp
  files, credentials, production identifiers, customer-specific details, or
  private operational runbooks.
- Keep durable public memory in `scratchpad/` only after summarizing or
  redacting sensitive context.
- Store private local memory, raw incident material, deployment notes, and secret
  references outside the tracked tree, for example under `.private/`.
