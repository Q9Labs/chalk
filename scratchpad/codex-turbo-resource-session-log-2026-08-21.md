# Turbo resource tuning session log

## 2026-08-21: Baseline and priority decision

- The clean-HEAD remote benchmark ran on a 10-core, 16 GiB M4 with Turbo 2.9.18 and cache reads bypassed.
- `check-types` took 15.54 seconds at 50% Turbo concurrency and 15.66 seconds at concurrency 15. Peak aggregate RSS was 3.10 GiB and 4.18 GiB, respectively.
- Concurrency 1 took 36.15 seconds with 1.77 GiB peak aggregate RSS, but dependency builds still caused a 365% sampled CPU peak.
- The user chose the lowest practical CPU and RAM use over wall-clock speed.
- Global Turbo concurrency is set to 1. Remaining work is to prove whether type checks and lint can omit dependency builds and to clamp worker pools inside individual test runners.

## 2026-08-21: Minimum-resource policy

- An artifact-free remote proof passed all 16 real workspace type checks after removing the eight dependency builds. It took 25.64 seconds with 1.76 GiB peak aggregate RSS.
- Workspace lint scripts operate on source through formatting, token, and TypeScript checks. The artifact-free lint run reached an existing React token-policy failure without an artifact-resolution failure.
- `check-types` and `lint` no longer depend on workspace builds.
- Root Vitest runs use one worker, root builds set `GOMAXPROCS=1`, and the full gate propagates one-worker limits to Vitest, Go/esbuild, and BEAM-based work.

## 2026-08-21: Verification

- The final remote `pnpm check-types` passed in 21.26 seconds with 1.56 GiB peak aggregate RSS.
- After building the existing undeclared `@q9labsai/diagnostics-contracts` test prerequisite, the final remote `pnpm test` passed all 17 tasks in 132.02 seconds with 1.43 GiB peak aggregate RSS. The sampled CPU peak was 399%, while user plus system time averaged about 129% of one core across the run.
- The low-resource full gate reached the existing web build failure after 356.88 seconds. Its peak aggregate RSS fell from 4.44 GiB to 3.29 GiB and its sampled CPU peak fell from 857% to 649%, but the runs stopped at different points.
- The web build fails identically with and without `GOMAXPROCS=1`, so the existing missing `apps/web/dist/client/index.html` error is unrelated to the resource policy.
- Root tests now declare the single `@q9labsai/diagnostics-contracts` build they require. This preserves clean-checkout test behavior without restoring the eight-build fan-out to type checks or lint.
