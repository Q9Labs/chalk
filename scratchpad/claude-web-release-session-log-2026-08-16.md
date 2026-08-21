# Web release through CI — session log 2026-08-16

## Goal

Exercise the new local-first web release runner by shipping a real production
deployment, at Hasan's request.

## Preflight findings

The local repository was not shippable as it stood:

- Local `master` was ahead 9 and behind 1 of `origin/master`. The missing commit was
  `20abdfc9 fix(dashboard): restore Episode diagnostics`, so deploying local HEAD would have
  regressed a live fix. The 9 local commits had never been pushed, so nothing had run against them.
- `runLocalWebRelease` builds from a detached worktree at the given SHA, so the dirty shared
  checkout could not enter the release. The uncommitted sidebar redesign stayed out for the
  same reason.
- No `.private/chalk-web-release.env` existed, so a local release had no `CLOUDFLARE_API_TOKEN`.
  Hasan chose the CI path instead.

`pnpm run release:web -- --dry-run` printed the full plan and executed nothing.

## Sync

Merged `origin/master` into the local release line inside `.worktrees/release-sync`, a detached
worktree, so the shared checkout and the other agents' in-flight edits were never touched. One
conflict, in `scripts/deploy/verify-web-deploy.test.mjs`: local had raised the verifier timeouts
while origin had added a `diagnosticsDocumentRequests` reset. Both are needed, so the resolution
keeps both. Result: `ab53fa9b`, gated locally with 382 web tests, a clean `check-types`, and the
deploy script tests.

## Bug the deployment found

Run 31934004341 failed in 13 seconds:

```
ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL  Command "wrangler" not found
pnpm exec wrangler --version failed with exit code 254
```

`runWebRelease` called `checkPinnedTools` before the workspace install, and Wrangler is a
workspace dependency. A warm local checkout has `node_modules` already, so the preflight passed
locally and failed on every fresh CI checkout. The dry run could not catch it either, since it
returns before the preflight.

Fix in `8407e8dc`: split the preflight. Node and pnpm come from the runtime and are still checked
first; `checkPinnedWrangler` now runs after `pnpm install`. Added a regression test that records
the call order and asserts `["install", "wrangler"]`; it fails against the old ordering.

## Result

Run 31934228062 is green. Staging uploaded and verified at
`https://31a07e50.chalk-staging.pages.dev`, production uploaded and verified at
`https://chalkmeet.com` on attempt 2. `https://chalkmeet.com/sw.js` reports
`8407e8dc560055af27f23769c397c7cd8aca7e32`.

## Left open

- `origin/master` is at `8407e8dc`. Local `master` is 1 ahead and 3 behind: another agent committed
  `acd88d5f` during the release. Whoever has a clean tree should fast-forward; I did not touch the
  branch, because the shared checkout is dirty.
## Second release

Hasan reported the old white sidebar in production, which was expected: the redesign was
uncommitted and so absent from `8407e8dc`. Committed as `e3448201` and shipped through run
31935876185. `https://chalkmeet.com/sw.js` reports `e344820121c9b1b8ad4c9f4e5a5ebda499c2da58`.
Details in `claude-dashboard-sidebar-session-log-2026-08-16.md`.

The runner behaved on the second outing: no new bugs, one operator error on my side, a short
SHA in the dispatch that the workflow correctly rejected.
