# Chalk Gate on q9gate 0.3

`pnpm gate` runs tracker generation checks, then `q9gate run` with Chalk's
existing checks declared as custom lanes in `gate.config.ts`. `pnpm gate:full`
runs the same tracker checks followed by `q9gate run --full`. Each gate runs
with `GOMAXPROCS=1`, `VITEST_MAX_WORKERS=1`, `ERL_FLAGS='+S 1:1'`, and
q9gate concurrency 1. “gate.report.json” records every selected/skipped lane.

Every gate profile first runs `doclint.mjs` and `theory-coverage.mjs` from this directory.
The pre-commit hook runs `pnpm gate:fast`: those doc checks, the tracker check, plus the `scope`, `format`,
`hygiene`, `secrets`, and `generated` lanes on staged files
(about 10 seconds). A run with nothing in scope fails in the `scope` lane; set
`GATE_ALLOW_EMPTY=1` only when that is intended. `GATE_SERVICES=external` drops
the `services` lane, because CI runs the API and Sync gates as separate jobs.

## The Gate workflow

`.github/workflows/gate.yml` runs on every pull request, every push to `master`,
every night, and on manual dispatch. `Select gate jobs` runs
`node scripts/gates/chalk-gate-plan.mjs --ci-jobs <base-ref>`, which uses the
same plan as the lanes to pick the jobs a pull request needs: the API gate, the
Sync gate, and the root lane groups. The root lanes run as parallel jobs, one
per lane group: `checks` (every lane that no other group names, including type
checks), `tests` (non-browser workspaces), `browser-tests` (the web app and SDK
consumer workspaces whose tests drive Chromium), `call-performance` (call bundle
budgets), `call-leaks` (call resource cleanup journeys), and
`build` (with Publint and Are The Types Wrong, which read the build output).
Each job sets `GATE_LANE_GROUP`, so q9gate plans only that group's lanes and
keeps its own selection inside the group. `Root gate` passes only when every
selected group passed; a job that the planner skips counts as passed. When the
planner cannot select jobs, for example because the base does not resolve, or
`Select gate jobs` fails, every job runs and every lane runs with `--full`. Pushes to `master`, the nightly run, and manual runs select every job and
run every lane with `--full`, so anything a pull request skips still runs once it merges, and
every master commit keeps its own run. A full run scans staged files and commits
for secrets: the pushed range on a push to `master`, otherwise the commits since
the base, or the last commit.

On a pull request that the planner narrowed, the workflow sets
`GATE_VULN_BASE_REF` to the base branch.
When OSV-Scanner (`osv` lane) or govulncheck (API gate) finds a vulnerability,
`osv-scanner.sh` and `govulncheck.sh` run the same scan on the merge base, and
`new-vulnerabilities.mjs` fails the pull request only for a finding the base
lacks, that is, a package version the pull request changed. A new advisory
against a package nobody changed fails the nightly run instead. Master pushes set
`GATE_OSV_BASE_COMMIT` to `github.event.before`: OSV compares against that exact
commit, not the merge base (including force pushes and merge commits). Branch
creation's all-zero SHA has no baseline and fails on all findings. An unavailable
old tip is fetched by SHA; a failed fetch fails the check. PR behavior is unchanged.
The separate Daily OSV workflow also scans without a baseline, stays red on any
finding, and reports to the standing `security-osv-daily` issue.

Only pushes to `master` save the Go build caches and the Metro cache, so pull
requests start from the latest master caches and do not evict each other's.
The API job sets `-count=1` because a cached Go test result would not see a
migration or database change. CI calls `scripts/gates/commit.sh` directly with
`GATE_WORKSPACE_CONCURRENCY=2` and `VITEST_MAX_WORKERS=2` instead of the
one-CPU `pnpm gate` alias, and installs the pinned Gitleaks and OSV-Scanner
releases through `.github/actions/setup-scanners` instead of compiling them with
`go run`.

`pnpm gate:explain <path>` asks q9gate why a path selects lanes. Local hooks
classify staged files. For branch/CI scope use `pnpm gate -- --base <ref>`;
q9gate compares `<ref>...HEAD`. Use `pnpm gate -- --files <path>` (repeatable)
or `GATE_FILES` (comma/newline-separated) for an explicit changed-file list.
Those worktree files are scanned for secrets in addition to the staged diff.
Gate-definition or unknown files fail closed to the full plan. q9gate counts
every path as source, so Chalk's planner alone decides which paths are unknown;
a self-test checks that every tracked path that makes q9gate run in full also
makes Chalk's plan run in full, which keeps the CI job selection exact. The Chalk custom lanes reuse the affected-workspace
and reverse-dependent planner, including Go, Elixir, Postgres, contracts,
recorder, publication, static checks, and resource-limited shell scripts.

Documentation-only changes keep routing self-tests, hygiene, diff-scoped secrets,
generated-output checks, and formatting. They do not
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
- Formatting, Fallow, Semgrep, workspace type checks, coverage tests, and
  builds follow affected source files and workspace dependents.
- The boundary gate covers cross-workspace dependency direction under `apps`,
  `packages`, and `sdks/typescript`. Use named package entrypoints or configured
  aliases: relative reach-through into another workspace's private source is
  rejected, and packages or SDKs cannot import applications. This lane does not
  enforce intra-workspace cycles, development-dependency policy, or orphan
  detection. Generated build output and dedicated fixtures are excluded.
- Selected workspace builds run through Turbo with their workspace dependency
  closure, using the existing `^build` task graph before building each consumer.
  The gate forces rebuilds rather than trusting cached build artifacts. Type
  checks and tests keep their affected-workspace scope.
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
- `infrastructure/managed-episode` and `infrastructure/nightly` run the API,
  Sync and recorder gates, whose tests read them.
  The full mode selects every rule. Separate nightly and release-candidate
  workflows add multi-node partitions, PostgreSQL failover, sustained load,
  process restart, and real-browser proof.

## Heavy runs on Instabox

Commit and push first: `box run` fetches the pushed HEAD, not working-tree edits.
Run Linux gates and browser suites on Instabox, never on the laptop or M4.
The disposable machine is deleted when the command ends. Keep the single-worker
settings above: the 4-vCPU / 8-GB machine has no room for extra workers.

```sh
box run -- 'bash scripts/gates/instabox-run.sh --browser'
box run -- 'bash scripts/gates/instabox-run.sh apps/api/scripts/gate.sh'
box run -- 'bash scripts/gates/instabox-run.sh scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh'
```

`scripts/gates/instabox-run.sh` installs locked dependencies and the missing Ruby/lsof
helpers, enables the Go version in `apps/api/go.mod`, and mounts data-disk scratch at `/tmp` for the command. The snapshot’s 4-GB
`/tmp` tmpfs cannot satisfy queue proofs’ 8-GB admission floor. Keeping their
scratch and fixed work paths under that one mount also preserves hard links. `--browser` installs Chromium; no command means `pnpm gate:full`.
The snapshot supplies Node, Go, Erlang/Elixir, OpenTofu, scanners, and Docker.
Versions are pinned in `.tool-versions`, `apps/api/go.mod`, and the CI setup actions.
PostgreSQL helpers own and
clean up their task containers. Use `scripts/gates/with-postgres.sh --` for Sync
runs; the API gate manages its own database. The root full gate selects both.
For a focused browser/performance command, replace the final command in the first
example and keep the Chromium install. The [performance runbook](../../docs/performance-budget.md)
separates diagnostic timings from calibrated budgets; do not enforce old timing
limits on the new runner without re-measuring them.

## Documentation checks

`node scripts/gates/doclint.mjs` checks maintained Markdown/MDX for missing local
links and literal repository paths, undeclared package scripts in package-manager commands, and retired runner
guidance. Frozen proof directories, fixture/testdata documents, changesets, and
changelogs are historical evidence, not maintained runbooks. Paths resolve from
the document or repository root. Examples must have an exact document/path entry
and a reason in `doclint-examples.json`; do not allow whole directories.

`node scripts/gates/theory-coverage.mjs` checks every prose paragraph and
list item in [theory.md](../../theory.md), except tracker-maintenance instructions and the test index.
Each has an `invariant` marker and a `test` mapping to a file and exact declared
test name. `theory-baseline.json` freezes today's unmapped text; it is debt, not
proof. New or changed requirements need a named test, not another baseline entry.
The checker proves the index is intact, not that a test proves every word.

The SDK effect rule has one adjacent, reasoned suppression per existing call.
New effects need a deliberate exception; do not suppress an entire file.
