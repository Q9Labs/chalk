# Mutation Testing Notes

Date: 2026-03-14
Source: YouTube video `Mutation Testing` by Jesse Warden
Video: https://youtu.be/SPGc3RM3V80

## Core Thesis

Mutation testing measures test quality, not just code coverage.

Idea:
- tool intentionally changes production code
- reruns tests
- checks whether tests fail

If tests still pass after the code was intentionally broken, that mutant "survived".
That usually means:
- missing boundary case
- weak assertion
- missing unhappy path
- test covers execution, not behavior

## Why It Matters

Main takeaway from the video:
- `100%` line/branch coverage can still hide weak tests
- coverage != confidence
- mutation testing helps answer: "would my tests catch a real regression?"

This matters even more with AI-generated tests:
- AI can produce passing tests quickly
- mutation testing is a quality filter on those tests

Also useful for release confidence:
- less fear shipping
- better signal before prod

## What Mutation Testing Is

Mechanism:
1. find a piece of code
2. mutate it
3. run tests against that one mutation
4. report whether tests killed or missed it

Common mutation examples:
- `>=` -> `>`
- `true` -> `false`
- `false` -> `true`
- flipped conditional branches
- changed return values

Vocabulary:
- `killed mutant`: tests failed as expected
- `surviving mutant`: tests still passed after the code change
- `mutation score`: percent of mutants killed

## Important Distinction

You do **not** write "mutation tests".

You use mutation testing to improve:
- existing unit tests
- assertions
- edge-case coverage
- sometimes types

The workflow is iterative:
1. run mutation testing
2. inspect surviving mutants
3. strengthen tests or types
4. rerun

## Video Example

Sample function idea:

```ts
function canEnterClub(age: number) {
  return age >= 18;
}
```

Existing tests:
- `19` => `true`
- `4` => `false`

Mutation:
- `age >= 18` -> `age > 18`

Result:
- both tests still pass
- but `18` is now broken
- mutant survives

Fix:
- add boundary coverage for `18`

Lesson:
- tests covered "some cases"
- tests did **not** protect the rule

## Key Principles From The Video

- boundary values matter a lot
- unhappy paths matter
- behavior assertions matter more than shallow execution
- mutation score is more honest than coverage alone
- not every surviving mutant is equally important
- goal is not perfect score at all costs
- goal is better awareness of blind spots

## Practical Warnings

Mutation testing can be slow.

The speaker's guidance:
- treat it more like performance testing than a normal fast unit-test loop
- some repos take minutes
- some can take hours

Practical strategy:
- avoid whole-repo runs at first
- run on changed files / affected modules
- use baseline score or diff-based runs

## Complementary Tools

The video also frames these as complementary:
- stronger types
- discriminated unions
- records / tighter constraints
- property-based testing

Point:
- sometimes the right fix is not "more tests"
- sometimes the right fix is "make invalid states unrepresentable"

## What We Should Remember For Chalk

When we start hands-on mutation testing, optimize for signal:
- start small
- start in a package, not app glue
- choose pure logic first
- prefer deterministic units over UI-heavy surfaces

Best first targets in Chalk:
- small utility modules
- pure business logic
- reducers / transforms / validators
- SDK logic with isolated dependencies

Avoid first-run targets:
- broad integration-heavy modules
- highly async orchestration files
- UI-only components unless behavior is sharply isolated

## Suggested Chalk Workflow For Next Chapter

1. Pick one small target module with already-good unit tests.
2. Run mutation testing on that narrow scope only.
3. Read surviving mutants one by one.
4. Decide per mutant:
   - real gap
   - acceptable edge case
   - type-system fix
   - test fix
5. Add/adjust regression coverage.
6. Rerun until the score and surviving mutants feel honest.

## What "Good" Looks Like

Not:
- chasing `100%` blindly
- inflating test count
- adding brittle tests for meaningless edge cases

Yes:
- boundary cases protected
- core domain rules asserted
- false positives reduced
- refactors feel safer

## Questions To Ask While Running It

- If this logic changed, would we want a test to fail?
- Is this mutant exposing a real behavior hole or noise?
- Should this be solved with a stronger assertion, a new test, or tighter types?
- Are we testing implementation details instead of business behavior?

## Next Chapter Plan

When we continue, use this order:

1. choose package + target file
2. confirm existing test coverage
3. add mutation-testing tool for narrow scope
4. run first report
5. kill the meaningful survivors
6. capture a repeatable command for future use

## One-Line Summary

Mutation testing asks the only question coverage cannot:
"If the code were wrong in a realistic way, would our tests notice?"

## Chalk Rep 1 Results - 2026-03-15

Target:
- `apps/web/src/lib/avatarGradient.ts`

Harness:
- `apps/web/stryker.config.json`
- `apps/web/vitest.stryker.config.ts`
- `apps/web/package.json` script: `test:mutation:avatar-gradient`

Dependency/setup findings:
- Stryker plugin auto-discovery did not work reliably with the Bun install layout here.
- Explicit `plugins: ["@stryker-mutator/vitest-runner"]` fixed runner loading.
- Using the main `vite.config.ts` inside the Stryker sandbox failed because it imports workspace package metadata outside the app boundary.
- A tiny dedicated `vitest.stryker.config.ts` solved that cleanly.

Score progression:
- initial score: `40.40%`
- improved score after test strengthening: `85.43%`

What improved coverage-wise:
- blank + whitespace fallback paths in `getAvatarSeed`
- blank/single/email/punctuation branches in `getAvatarInitials`
- malformed/default handling in `sanitizeAvatarGradientPreference`
- server/client storage behavior
- event dispatch behavior
- exact CSS/derived/preset gradient payload assertions instead of only stability checks

What the first report taught us:
- a "stable for same seed" assertion is too weak for hash-based selection logic
- imported constants in tests can hide constant-string mutants
- storage/event helper branches are easy to miss without explicit side-effect assertions

Remaining survivor pattern summary:
- some survivors look equivalent or low-value:
  - fallback string literals behind always-truthy branches
  - trim/regex variants neutralized by existing normalization/filtering
  - sanitize/default branches that still collapse to the same default object
- one hash arithmetic mutant still survives; good candidate for a later deeper rep if we want to stress exact preset selection further

Next best targets after this rep:
- `packages/sdk-core/src/events.ts` for the smallest SDK-first loop
- `packages/sdk-core/src/transforms.ts` for the highest-signal pure-logic SDK rep
