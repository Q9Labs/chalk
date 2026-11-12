# Chalk

Chalk is an open-source platform for real-time collaboration and communication. Use Space and Episode as defined in [GLOSSARY.md](GLOSSARY.md). Keep product language role-neutral unless an integration needs specific terms.

Docs explain product intent, domain decisions, and operational judgment; verify claims about current behavior against code, contracts, and checks.

Put shared behavior in packages first, then wire it into apps. Don't fix SDK behavior only in a demo. This repo is public: keep production identifiers, customer details, private runbooks, and raw debug artifacts out of Git.

## Architecture

- Code stays where it is; use the [feature map](features.json) to find a capability's paths. Look up a feature with `node scripts/gates/feature-map.mjs --feature recording` or a path with `node scripts/gates/feature-map.mjs --path <file>`.
- The Go API keeps domain logic and public `/v1` routes under `apps/api/internal`; operational routes such as `/healthz` stay unversioned. Keep media and sync providers behind their ports and adapters. For API changes, use the [Go conventions](apps/api/docs/code-standards.md), [route workflow](apps/api/docs/route-workflow.md), and [database workflow](apps/api/docs/database-workflow.md) as relevant. Database removals must keep the previous release runnable.
- The Elixir Sync server uses Postgres as the durable authority; local coordinators, queues, presence, and SDK replicas are disposable. Preserve the tenant-and-Episode authority and transaction boundaries, bound retained work and data, and treat socket loss as presence rather than a durable lifecycle event. Protocol v1 is the production surface. Read the [Sync README](apps/sync/README.md) before changing its protocol, lifecycle, or deployment behavior.
- After changing a contract, route, migration, or other generator input, run `pnpm run regen`. Use `pnpm run check:generated` to find stale output. See [contract codegen](docs/contract-codegen.md).
- For observability or service-monitoring changes, follow [observability](docs/observability.md). Preserve journey and trace context, keep sensitive data out of telemetry, and update the journey ledger and observability proof when a user-visible lifecycle changes.
- When production breaks, restore service first by the [incident runbook](docs/operators/incident.md): rollback or fix forward, the hotfix workflow, and the kill switches.

## Verification

Use the relevant checks for the change. Run heavy Linux checks on Instabox; [gate operations](scripts/gates/README.md) covers the full gate, API and Sync gates, setup, and the commit hook. For code review, apply [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Orbs

Every change to UI or user-facing behavior is tested on an Orb: the running product on its own Instabox machine, started from Chalk's base snapshot with your branch on top. A change with no visible effect (docs, tests, CI, a refactor that keeps behavior) skips it.

1. Push the branch, then run `orb start chalk <branch>` (the `orb` skill). It starts the stack, runs the journeys against the public URL, saves the panel and evidence (the command prints where), and deletes the machine, in about 5 to 10 minutes.
   The scripted journeys are a baseline. When they don't cover the feature you changed, use `orb up chalk <branch>` instead of `orb start`, drive that feature through the real UI, run `orb verify <orb>`, and finish with `orb down <orb>`.
2. Put the preview URL, the journey results and the evidence location in the PR body, and say that a reviewer recreates the Orb with `orb resume chalk:<branch>`.
3. Never leave an Orb running. If the test fails, fix the cause and run it again. `orb start --keep-on-fail` keeps a failed Orb for inspection, and `orb down <orb>` deletes it.

Orbs share the Instabox plan's monthly credit with CI. `orb` refuses to start machines past that credit, and raising the cap needs the owner's approval.
