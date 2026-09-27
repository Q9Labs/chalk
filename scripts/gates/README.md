# Chalk Gate on q9gate 0.3

`pnpm gate` runs tracker generation checks, then `q9gate run` with Chalk's
existing checks declared as custom lanes in `gate.config.ts`. `pnpm gate:full`
runs the same tracker checks followed by `q9gate run --full`. Each gate runs
with `GOMAXPROCS=1`, `VITEST_MAX_WORKERS=1`, `ERL_FLAGS='+S 1:1'`, and
q9gate concurrency 1. `gate.report.json` records every selected/skipped lane.

`pnpm gate:explain <path>` asks q9gate why a path selects lanes. Local hooks
classify staged files. For branch/CI scope use `pnpm gate -- --base <ref>`;
q9gate compares `<ref>...HEAD`. Gate-definition or unknown files fail closed
to the full plan. The Chalk custom lanes reuse the legacy affected-workspace
and reverse-dependent planner, including Go, Elixir, Postgres, contracts,
recorder, publication, static checks, and resource-limited shell scripts.

q9gate 0.3 skips custom lanes on documentation-only changes before consulting
their triggers. Chalk conservatively classifies documentation as gate-defining,
so those diffs run the full safety net rather than dropping always-on checks.
The toolkit issue is recorded in q9stack's v0.3 toolkit-issues ledger.

The old `--target`, `GATE_FILES`, and `GATE_HEAD_REF` interfaces are not in the
q9gate CLI. Use `--base` for a branch diff and `--lane <id>` for a focused
check. `GATE_TARGET=web|mobile` still reaches Chalk's legacy workspace planner
for staged or branch diffs, but q9gate does not provide the old CLI target
validation or explicit-file input. Do not infer a shipment target from branch,
release mode, or directory.

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
