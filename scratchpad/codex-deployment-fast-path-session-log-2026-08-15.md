# Deployment fast-path session log

- 2026-08-15: Mapped the local API gate, web release job, managed release artifacts, and private cutover controller. The current API gate is serial and duplicates the curated vet pass inside `go test`; the current release always builds both API and Sync; the current private cutover is release-specific and restarts the complete runtime.
- 2026-08-15: Measured the API performance harness at 177.62 seconds cold and 57.46 seconds warm. It reports throughput and errors without enforcing a performance contract, so the unfinished harness will be removed instead of remaining a release gate.
- 2026-08-15: Agreed target: one deterministic local API gate with isolated migrated Postgres, safe parallel analysis, no duplicate vet; component-aware API/Sync build and restart planning; preferred local web release with staging by default, explicit emergency bypass, exact-SHA production verification, and CI fallback through the same implementation.
## Integration

- Removed the unfinished API performance harness and folded API verification
  into one database-owned gate with safe parallel lanes.
- Added component planning and per-component manifest provenance so unchanged
  API or Sync images can be carried from the stable release without rebuilding.
- Added a local-first exact-SHA web release with staging default, explicit
  bypass, one cached build, and the same CI fallback entry point.
- Replaced the automatic CI gate-and-deploy chain with a manual exact-SHA
  release workflow. No production or cloud action was run during this work.
- Dogfood found and fixed pnpm's literal argument separator being rejected by
  the web release CLI. The final dry-run transcript is
  `/tmp/chalk-dogfood-release-cli-final-20260815T150920-65253.log`.
- A production-mode web workspace build took 41.1 seconds cold and 1.35 seconds
  warm with all eight Turbo tasks served from cache.
- The canonical repository gate stopped at unrelated shared language-ratchet
  deltas before substantive checks. The direct API gate then exposed two stale
  integration contracts that had been skipped by the old database aliases.
- Repaired those chat attachment and Whiteboard fixture contracts. The full API
  gate then passed, including migrated database tests and lifecycle smoke.
