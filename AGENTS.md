# Chalk

OSS modern real-time collaboration and communication.

The commit hook runs the fast gate lanes. The Gate workflow runs the full root, API, and Sync gates on every pull request. Run `pnpm run gate` before you open a PR, `apps/api/scripts/gate.sh` for API changes, and `apps/sync/scripts/gate.sh` for Sync changes. To run a heavy gate on the M4, use `scripts/gates/remote.sh root|api|sync|recorder`.

- Use the vocabulary in `GLOSSARY.md`; CI checks banned terms.
- Put shared behavior in packages first, then wire it into apps. Don't fix SDK behavior only in a demo.
- Keep product language role-neutral unless an integration needs specific terms.
- After you change a contract, route, migration, or other generator input, run `pnpm run regen`. `pnpm run check:generated` names every stale output in seconds.
- For observability or service monitoring changes, read `docs/observability.md`. It also lists where each service's failure evidence is retained.
- Diagnose affected journeys using structured logs and their W3C trace IDs. Episode Debugger and its CLI are not available.

## Where things live

- API (Go): `apps/api/AGENTS.md`, with conventions in `apps/api/docs/code-standards.md`, routes in `apps/api/docs/route-workflow.md`, and migrations in `apps/api/docs/database-workflow.md`.
- Sync (Elixir): `apps/sync/AGENTS.md`.
- Contracts and code generation: `docs/contract-codegen.md`.
- Gates, the commit hook, and the M4 runner: `scripts/gates/README.md`.
- Recording bundle formats: `apps/api/internal/recordingbundle`.
- Product outcomes and remaining work: `tracker.yaml`.
- Code review: reviewers apply `CODING_STANDARDS.md` to the diff.

This repo is public. Keep production identifiers, customer details, private runbooks, and raw debug artifacts out of Git.
