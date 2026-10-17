# Chalk Gate on q9gate 0.3

`pnpm gate` runs tracker generation checks, then `q9gate run` with Chalk's
existing checks declared as custom lanes in `gate.config.ts`. `pnpm gate:full`
runs the same tracker checks followed by `q9gate run --full`. Each gate runs
with `GOMAXPROCS=1`, `VITEST_MAX_WORKERS=1`, `ERL_FLAGS='+S 1:1'`, and
q9gate concurrency 1. The testbox wrapper invokes the same commit script through
`pnpm exec` instead of the one-CPU package alias, allowing Go to use the
allocated CPUs; Vitest and Erlang remain capped at two workers/schedulers.
`gate.report.json` records every selected/skipped lane.

The pre-commit hook runs `pnpm gate:fast`: tracker check plus the `scope`, `format`,
`hygiene`, `secrets`, and `generated` lanes on staged files
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
  The full mode selects every rule. Separate nightly and release-candidate
  workflows add multi-node partitions, PostgreSQL failover, sustained load,
  process restart, and real-browser proof.

## Running a gate on testbox

`scripts/gates/remote.sh <root|api|sync|recorder|-- command...>` runs on a
disposable Linux Droplet through the testbox skill, never on the M4.
`--dry-run` prints the exact plan without creating a box.

Testbox ships the real tip and merge-base with `origin/HEAD`, then commits
tracked working-tree changes on top. Stage new files before running: the wrapper
rejects non-ignored untracked files rather than silently omitting them. Ignored
files (including local dependencies and secrets) are not shipped. Custom base
refs must exist in testbox's limited history; fetch `origin/master` locally first.

The wrapper checks Node, Go, Erlang, Elixir, and OpenTofu against the same
version sources as Gate CI and installs only mismatches. The shared testbox
image includes these pins, Gitleaks, Semgrep, prebuilt OSV, and the pinned
Playwright Chromium revision. Matching Chromium skips OS dependency setup;
a different revision still installs its dependencies. The existing helpers own PostgreSQL 18.3 and Sync topology.
Root and custom runs verify the repo's Playwright Chromium revision.
TTL covers provisioning, setup, and the gate: root/custom 60 minutes, API/Sync
45 minutes, recorder 20 minutes (2 CPU / 4 GB).
Root defaults to `c-8` (8 dedicated CPU / 16 GB). API and Sync use
`c-8`, recorder uses `s-2vcpu-4gb`, and custom commands keep
`s-4vcpu-8gb`. The measured region is `blr1`, which offers both root trial
sizes. New shared images must be available there before use. This is an
allocation choice, not a claim that the region is faster.

Each run retains testbox's $0.50 default ceiling and automatic cleanup.
`CHALK_REMOTE_SIZE`, `CHALK_REMOTE_REGION`, `CHALK_REMOTE_TTL`, and
`CHALK_REMOTE_BUDGET` override the allocation for a bounded experiment.
The snapshot must be available in the selected region.
`CHALK_PHASE` epoch markers and UTC headers time each setup step and the gate;
testbox imports the markers into receipt phases. The job checks that competing
OS upgrade and firmware timers/services are masked.

Provisioning prints live. The current testbox CLI saves job output but does not
stream it; collected step headers and the final 60 lines print at completion.
`CHALK_REMOTE_VERBOSE=1` prints the complete collected job log.
`CHALK_REMOTE_TAIL_LINES` and `CHALK_REMOTE_LOG_DIR` control the tail and combined
local log (default `${TMPDIR:-/tmp}/chalk-remote-logs`). Testbox keeps its receipt,
launcher log, job log, and artifact archive in `~/.local/state/testbox/<task>/`.
The wrapper returns testbox's exit status, including setup and provisioning failures.
