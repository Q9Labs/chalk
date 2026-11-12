# Review standards

Reviewers apply these to a diff. They are judgement calls that no gate can check. Mechanical rules belong in the gates, and language conventions live in each app's own standards (for Go, `apps/api/docs/code-standards.md`).

## A fix must reproduce the real failure

A fix for a production failure needs a test that fails without the fix and is built from what was observed: a sanitized fixture from the real bundle, the logged request, or the retained trace. A fix proven only against invented input can pass review and still fail in production, as the first VP8 Export fix did.

## Sibling paths keep the same limits

When two paths expose the same kind of thing, such as Recording and Transcript download URLs or two credential endpoints, they must share one helper for lifetimes, size limits, rate limits, and authorization. Flag a change that tightens one path and leaves its sibling behind.

## Existence-probing endpoints give nothing away

Sign-in, password reset, invitation, and lookup endpoints must return the same response shape and status for known and unknown subjects. They must not do visibly different work, such as sending mail inline for one case only. Flag differences a caller could measure.

## Locks are taken in one order

When a change takes more than one lock, row lock, or advisory lock, check the order against every other path that takes the same locks. Flag any path that takes them in a different order.

## Failure paths leave evidence

A new terminal failure, rejection, or timeout must say why, in a bounded and redacted form, in the log, span or metric that service already uses (see `docs/observability.md`). A bare status or a generic message sends the next person to the wrong place.

## Generated outputs come from their generators

A diff that edits a generated file by hand, or adds a second copy of logic that a generator or a shared module already owns, should instead change the source and run `pnpm run regen`.

## Tests do not replace our own code

A test may not mock a module of this repository (`vi.mock`, `vi.doMock`, `jest.mock` or `mock.module` with a relative or workspace-package specifier), because it then asserts on wiring the author just wrote and breaks on every refactor. Run the real module and fake only the real boundary: the network, time, storage, a provider's SDK or a browser API. A seam that exists only so a test can fail a chunk download or inject a loader is a fine parameter with a production default. The `ast-grep` lane of the Root gate enforces this with no suppressions (`forbid-own-module-mocks` in `scripts/gates/ast-grep.mjs`). Assertions on mock calls cannot be judged by lint, since a callback the test passed in being called is a real output, so the `mock-calls` lane counts them per package against `scripts/gates/mock-call-baseline.json` and fails when a count rises. After a drop, run `node scripts/gates/mock-calls.mjs --update`.
