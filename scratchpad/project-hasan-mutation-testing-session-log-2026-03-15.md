# Project Hasan Mutation Testing Session Log

## 2026-03-15 00:35:59 PKT

- implemented first mutation-testing rep in `apps/web`
- added local Stryker + Vitest harness for `src/lib/avatarGradient.ts`
- fixed Bun/Stryker plugin discovery by loading `@stryker-mutator/vitest-runner` explicitly
- added dedicated `vitest.stryker.config.ts` because the app's main `vite.config.ts` breaks inside the mutation sandbox
- expanded avatar-gradient tests around defaults, initials, storage, events, CSS, and exact derived/preset outputs
- mutation score moved from `40.40%` to `85.43%`
- recorded findings in `scratchpad/project-hasan-mutation-testing-notes-2026-03-14.md`

## 2026-03-15 17:43:00 PKT

- started second mutation rep for shared participant avatar recipe in `packages/sdk-core/src/utils/participant-colors.ts`
- reused the existing `apps/web` Stryker + Vitest harness pattern to avoid adding fresh mutation tooling
- added dedicated target config `apps/web/stryker.participant-avatar.config.json`
- added focused mutation-spec file `apps/web/src/lib/participantAvatarRecipe.test.ts`
- next: run first mutation pass, inspect survivors, then tighten assertions only where the survivor exposes a real gap

## 2026-03-15 17:48:00 PKT

- learned that Stryker in `apps/web` does not mutate files outside the package sandbox; targeting `../../packages/sdk-core/...` only triggered a dry run
- pivoted to a package-local harness in `packages/sdk-core`
- added `packages/sdk-core/stryker.participant-avatar.config.json`
- added `packages/sdk-core/vitest.stryker.config.ts`
- added focused Vitest mutation spec `packages/sdk-core/mutation/participant-colors.mutation.test.ts`
- added `packages/sdk-core/package.json` script `test:mutation:participant-avatar-recipe`

## 2026-03-15 17:52:00 PKT

- first real sdk-core mutation pass on `participant-colors.ts`: `42.48%`
- tightened the spec around exact custom gradients, exact border alpha, invalid custom fallback, seeded palette expectations, preset export shape, and helper outputs
- second pass moved to `77.78%`
- added one more targeted iteration for whitespace-only initials, malformed custom colors, light/dark theme foregrounds, and a broader seeded-name map
- third pass reached `84.97%`
- remaining survivors cluster around:
  - hash arithmetic internals that need a much wider seed corpus to distinguish
  - `getReadableTextColor` math mutants that likely want their own dedicated helper-level rep
  - equivalent-ish initials normalization mutants inside already-normalized branches

## 2026-03-15 06:56:26 PKT

- cleaned the notes/log path after moving the mutation spec out of `src/__tests__`
- re-running the scoped sdk-core gate so the mutation artifact and final proof match the actual harness layout

## 2026-03-15 06:57:34 PKT

- fixed the `sdk-core` mutation script after Bun resolved the wrong `bunx --package` binary
- switched the script to the already-installed monorepo Stryker binary at `../../apps/web/node_modules/.bin/stryker`
- refreshed the package-local mutation artifact with the real `mutation/participant-colors.mutation.test.ts` harness
- score remains `84.97%`; diminishing-return survivors unchanged
