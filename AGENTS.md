# Chalk

Ultra low-latency video conferencing built on Cloudflare RealtimeKit. This is a
monorepo for the public SDK packages, demo apps, docs, and selected support
tooling.

## Quality Gate

`pnpm run gate` is the canonical pre-remote quality contract; run it before
asking for a commit, PR, or deployment (`pnpm run gate:explain` documents it).
Hooks are non-mutating — never rely on them to format, fix, stage, regenerate,
stash, reset, or revert files. Language-specific work has its own focused gate:
run `apps/api/scripts/gate.sh` after touching Go, `apps/sync/scripts/gate.sh`
after touching the Elixir sync server.

Dev server output is mirrored to `.logs/dev-server.log` when using logged dev
scripts such as `pnpm run dev`; app-local runs write the same path under that
app directory. When debugging a running app, inspect the latest output with
`tail -n 200 .logs/dev-server.log` from the relevant working directory.

## Database Migrations

Treat DB schema changes as release blockers. When code or generated queries
reference new columns, tables, or indexes, apply and verify the matching
migrations before closing the change, and keep checked-in SQL migrations in sync
with embedded API startup migrations. Prefer automated migration and post-deploy
verification over manual-only notes.

## Testing

Add or update focused automated tests for behavior changes. For UX changes, also
verify the flow in a real browser when the local app can exercise it. Keep
user-facing product language role-neutral unless an integration requires a
specific domain vocabulary.

## Operational Completeness

Treat observability as part of the behavior being shipped. Every new or changed
API capability must propagate Chalk's journey and W3C trace context across its
boundaries and add useful traces, metrics, structured logs, and failure signals
to the existing observability stack. The change is incomplete until its success
and failure paths are visible and the relevant local observability proof passes;
never log secrets or sensitive payloads to gain that visibility.

Every newly deployed service must expose an appropriate health or synthetic
check and be added to the monitor registry in
`infrastructure/uptime-worker/src/index.ts`, with focused tests and status
projection when it is a user-visible component. Verify the monitor's real
failure and recovery path before calling the service complete.

Consumer-facing platform capabilities must ship with the SDK surface needed to
use them safely. For webhooks, this includes versioned event types and schemas,
signature verification over the raw request body, typed dispatch or processing
helpers, idempotent consumer guidance or helpers, test fixtures, and package
documentation. Keep server-only webhook handling out of browser bundles.

## Where To Write Code

Packages are the source of truth; demo apps should stay thin.

- `sdks/typescript/client`: client logic, room management, transport integration,
  auth helpers, shared types, diagnostics, webhooks.
- `sdks/typescript/react`: React hooks and components.
- `sdks/typescript/react-native`: React Native hooks, components, and native
  bridges.
- `packages/assets`: reusable CDN asset metadata and brand assets.
- `packages/whiteboard`: whiteboard collaboration features.
- `packages/ui`: shared UI primitives.
- `apps/web`: Chalk web app and local verification surface.
- `apps/docs`: public documentation.
- `apps/mobile`: demo and official app.
- `apps/api`: Go control-plane API. Read `apps/api/AGENTS.md` before working on the API.
- `apps/sync`: Elixir/OTP WebSocket sync server (the primary `SyncEngine`
  adapter). Read `apps/sync/AGENTS.md` before working on the sync server.
- `infrastructure`: infrastructure-as-code (IaC) tooling.

For product behavior, networking, auth, observability, SDK APIs, retries,
diagnostics, or error handling, implement the owned package first and wire demo
apps afterward. Avoid app-only fixes when package code should own the behavior.

## Public Repo Hygiene

This is a public repo: never commit secrets, production identifiers, customer
details, private runbooks, or generated debug artifacts (logs, screenshots, temp
files). Keep raw incident material, deployment notes, and secret references
outside the tracked tree (e.g. `.private/`); durable public memory belongs in
`scratchpad/` only after redacting sensitive context.
