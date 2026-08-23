# Test Suite Reduction Session Log

## 2026-08-23

- Hasan authorized a maximum-reduction audit followed by immediate execution across the monorepo.
- The decision rule is to keep only tests that uniquely protect a current, material contract or costly failure mode. Test count and line coverage are not preservation goals.
- Read-only audit lanes started for TypeScript packages, application surfaces, the Go API, the Elixir Sync server, and infrastructure/tooling.
- A clean remote baseline started on `agents-macmini`; no secrets or production state were copied.
- The semantic audit covered 773 tracked test files. Conservative first-pass keep decisions were challenged until the boundary-focused floor reached about 315 files, a planned 59% reduction.
- The executable spec is `scratchpad/test-suite-reduction-spec-2026-08-23.md`. A critique added a pinned baseline, explicit security/protocol/concurrency/observability scenarios, required checks outside the full gate, and a production-path diff guard.
- Five isolated worktrees were created for disjoint TypeScript, application, API, Sync, and tooling execution lanes. No deletion work starts until the clean remote full-gate baseline completes.
- The tracked-only remote baseline passed `pnpm run gate -- --full` in 578 seconds at source commit `e2236bfa`.
- The five deletion lanes were integrated in a dedicated worktree because the shared root acquired unrelated staged and unstaged changes during execution. No shared-root change was reset, stashed, or overwritten.
- The integrated suite contains 319 tracked test files, down from 773. The diff removes 454 test files and 37,528 lines while retaining the audited boundary floor.
- The first integrated JavaScript run exposed JSX in a `.ts` suite. Renaming the retained invite-link suite to `.tsx` restored the Web lane, and the complete `pnpm test` workspace run passed.
- The API gate exposed retained suites whose helpers lived in deleted files. Those helpers were folded into retained suites without adding test files; the API race gate then exposed a fixed-ID database collision, which was removed by generating isolated fixture IDs.
- The retained Sync campaign initially applied UUID leak assertions to the entire campaign instead of their original phase outputs. Scoping those assertions to the external-media and wire phases restored the complete Sync gate at 263 passing tests with 3 intentional exclusions.
- The retained-event repair proof had two stale assumptions: fixture timestamps mixed `now()` with a fixed cleanup clock, and current cleanup code ran against a historical schema. Fixed timestamps and a schema advance before cleanup made all four migration cases deterministic and green.
- Managed configuration, deployment control, release verification, contract parity, all four migration proofs, the API race gate, the complete Sync gate, and the replicated PostgreSQL topology/failover profile passed explicitly.
- The first final full gate exhausted the remote disk while OpenTofu installed the AWS provider. After deleting only the two obsolete baseline checkouts and the partial provider cache, the same integrated source passed `pnpm run gate -- --full`.
- Maintainer dogfood is covered by the green workspace tests, API lifecycle smoke, Sync breaker replay, packed SDK end-to-end check, and canonical full gate. No user-visible surface changed, so a browser recording would not add evidence.
- The final patch-mode stage contains 478 changed paths, 716 insertions, and 37,550 deletions. The exact classifier returns 319 test-like files, and the staged path guard contains no production source, migration, workflow, or infrastructure definition.
- A second semantic challenge rejected source-text, export, mock CRUD, and configuration-permutation suites as evidence. The hard floor is 162 files: 50 SDK/package, 17 application, 47 API, 38 Sync, and 10 tooling proofs.
- The second deletion pass exposed empty package test commands, stale migration harness scope, and Go helpers that only deleted tests referenced. Empty test commands were removed, migration proofs were pinned to their intended versions, unused test helpers were deleted, and one unreachable API route-mount wrapper with no callers was removed.
- Workspace tests, the API race gate, the complete Sync gate, replicated topology/failover, all four migration proofs, managed deployment safeguards, release verification, generated-contract checks, and the language ratchet pass at the 162-file floor.
- The first second-pass full gate found that the audit had deleted `artifact.ex`, a non-test-named helper loaded dynamically by the retained Sync breaker. Restoring that helper kept the classifier at 162 files and the deterministic correctness record/replay campaign passed.
- The exact integrated tree then passed the canonical remote `pnpm run gate -- --full` contract at the 162-file floor.
- The second-pass patch-mode stage contains 206 changed paths, 300 insertions, and 33,561 deletions. The exact classifier returns 162 test files, and the non-test path guard contains only test routing metadata, manifests, the tightened language baseline, two retained migration harness repairs, and one proven unreachable API helper.
