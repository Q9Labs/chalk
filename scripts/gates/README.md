# Chalk Gate on q9gate 0.3

`pnpm gate` runs tracker generation checks, then `q9gate run` with Chalk's
existing checks declared as custom lanes in `gate.config.ts`. `pnpm gate:full`
runs the same tracker checks followed by `q9gate run --full`. Each gate runs
with `GOMAXPROCS=1`, `VITEST_MAX_WORKERS=1`, `ERL_FLAGS='+S 1:1'`, and
q9gate concurrency 1. `gate.report.json` records every selected/skipped lane.

The pre-commit hook runs `pnpm gate:fast`: tracker check plus the `scope`, `format`,
`hygiene`, `secrets`, `language-ratchet`, and `generated` lanes on staged files
(about 10 seconds). The full gate runs in `.github/workflows/gate.yml` on every
pull request. A run with nothing in scope fails in the `scope` lane; set
`GATE_ALLOW_EMPTY=1` only when that is intended. `GATE_SERVICES=external` drops
the `services` lane, because CI runs the API and Sync gates as separate jobs.

`pnpm gate:explain <path>` asks q9gate why a path selects lanes. Local hooks
classify staged files. For branch/CI scope use `pnpm gate -- --base <ref>`;
q9gate compares `<ref>...HEAD`. Use `pnpm gate -- --files <path>` (repeatable)
or `GATE_FILES` (comma/newline-separated) for an explicit changed-file list.
Those worktree files are scanned for secrets in addition to the staged diff.
Gate-definition or unknown files fail closed to the full plan. The Chalk custom lanes reuse the affected-workspace
and reverse-dependent planner, including Go, Elixir, Postgres, contracts,
recorder, publication, static checks, and resource-limited shell scripts.

Documentation-only changes run the four always-on Chalk lanes: routing
self-test, language ratchet, hygiene, and diff-scoped secrets. They do not
force unrelated service or workspace checks. The package-boundary check still
runs its own test and q9gate's built-in Dependency Cruiser lane with Chalk's
`.dependency-cruiser.cjs` configuration and a TypeScript analysis guard.

Use `pnpm gate -- --target web|mobile` for a shipment-scoped gate; the
`GATE_TARGET` environment form remains supported. q9gate validates the native
target name, while Chalk's planner retains dependency-aware workspace
exclusions and rejects incompatible mixed-platform changes. Target roots cover
the selected app and shared code; Chalk validates q9gate's unfiltered
`allChangedFiles` so an incompatible path cannot disappear during target
filtering. `GATE_HEAD_REF` is not supported by q9gate; `--base`
compares against `HEAD`. Use `--lane <id>` for a focused check. Do not infer a
shipment target from branch, release mode, or directory.

## Selection Rules

- Repository hygiene and diff-scoped secret scanning always run.
- The language vocabulary ratchet always runs. It compares case-insensitive,
  identifier-aware banned-term counts per surface with the committed baseline;
  decreases require `pnpm run language:ratchet:update` so each migration wave
  becomes the next locked baseline.
- Formatting, Fallow, Semgrep, workspace type checks, coverage tests, and
  builds follow affected source files and workspace dependents.
- The boundary gate covers cross-workspace dependency direction under `apps`,
  `packages`, and `sdks/typescript`. Use named package entrypoints or configured
  aliases: relative reach-through into another workspace's private source is
  rejected, and packages or SDKs cannot import applications. This lane does not
  enforce intra-workspace cycles, development-dependency policy, or orphan
  detection. Generated build output and dedicated fixtures are excluded.
- Tests run once with coverage; lint aliases do not repeat formatting or type
  checks.
- Go API changes run the complete language gate. Elixir Sync changes run the
  shared correctness profile: the full zero-skip PostgreSQL suite, Credo, the
  replayed v1 breaker, and focused Sync and whiteboard SDK tests. Both use a
  disposable, migrated PostgreSQL container that is removed on exit.
- Contract producers and consumers run generated-contract and SDK drift checks.
- The patched image-size parser fixture runs when its patch or guard changes.
- Dependency inputs run Syncpack and OSV against tracked product lockfiles.
- Publishable packages run Publint and Are The Types Wrong only when affected.
- Architecture and recorder inputs run their standalone gates.
  The full mode selects every rule. Separate nightly and release-candidate
  workflows add multi-node partitions, PostgreSQL failover, sustained load,
  process restart, and real-browser proof.

## Running a gate on the M4

`scripts/gates/remote.sh <root|api|sync|recorder|-- command...>` runs a gate in
a throwaway checkout on the M4 and always cleans up; `--dry-run` prints the plan.
It snapshots the local commit plus uncommitted work as `origin/master` and the
branch tip, so branch scope and Fallow work. Before starting it reaps stale
`/tmp/chalk-*` checkouts and orphaned `chalk-gate-postgres-*` containers, and it
refuses to start below `CHALK_REMOTE_MIN_FREE_GIB` free disk. Dependencies come
from the M4 user's default pnpm, Go, Hex, and Mix caches. The root
gate fails early when installed packages differ from `pnpm-lock.yaml`
(`check-install.mjs`), and slow steps run under `with-timeout.sh`.
