# Web SDK Logic Reset Session Log - 2026-07-05

## Progress

- Identified web code that was acting as SDK logic: room creation, token exchange, join-context storage, room entry availability, meeting runtime provider wiring, mobile join redirects, SDK debug export plumbing, scheduled room SDK client calls, SDK avatar helpers, and diagnostics/media simulation.
- Preserved app routes and visible UI shells where useful, but removed stale reusable behavior from the web app.
- Separated the small app API URL helper used by public status/share pages from the removed conferencing session helper.

## Verification

- Web SDK import/stale helper scan returned no matches under `apps/web`.
- `pnpm --dir apps/web exec tsc --noEmit --project tsconfig.json` passed.
- `pnpm --dir apps/web run test` passed: 5 files, 17 tests.
- `pnpm --dir apps/web run build` passed. Node printed a `module.register()` deprecation warning from the `tsx` runtime hook during asset sync.
- `pnpm exec oxfmt --check apps/web/src apps/web/package.json apps/web/tsconfig.json apps/web/vitest.config.ts` passed.
- `git diff --check -- apps/web pnpm-lock.yaml scratchpad/web-sdk-logic-reset-session-log-2026-07-05.md` passed.
