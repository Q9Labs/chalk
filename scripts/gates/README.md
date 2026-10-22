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
consumer workspaces whose tests drive Chromium), and
`build` (with Publint and Are The Types Wrong, which read the build output).
Each job sets `GATE_LANE_GROUP`, so q9gate plans only that group's lanes and
keeps its own selection inside the group. `Root gate` passes only when the
planner and every selected group passed; a job that the planner skips counts as
passed. Pushes to `master`, the nightly run, and manual runs select every job and
run every lane with `--full`, so anything a pull request skips still runs once it merges, and
every master commit keeps its own run. A full run scans staged files and commits
for secrets: the pushed range on a push to `master`, otherwise the commits since
the base, or the last commit.

On a pull request, the workflow sets `GATE_VULN_BASE_REF` to the base branch.
When OSV-Scanner (`osv` lane) or govulncheck (API gate) finds a vulnerability,
`osv-scanner.sh` and `govulncheck.sh` run the same scan on the merge base, and
`new-vulnerabilities.mjs` fails the pull request only for a finding the base
lacks, that is, a package version the pull request changed. A new advisory
against a package nobody changed fails the next master push or nightly run
instead, because those runs leave `GATE_VULN_BASE_REF` empty and fail on every
finding.

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
  The full mode selects every rule. Separate nightly and release-candidate
  workflows add multi-node partitions, PostgreSQL failover, sustained load,
  process restart, and real-browser proof.

## Running a gate on the M4 (default)

`scripts/gates/remote.sh <root|api|sync|recorder|-- command...>` runs on
`agents-macmini` in a throwaway checkout. `--dry-run` prints the plan without SSH.
The runner snapshots the local commit plus staged, unstaged, and untracked work;
ignored files are not shipped. The merge-base tree becomes `origin/master`.

The M4 registers a durable SQLite ticket, then a detached dispatcher waits and runs
the job there. Ticket order is FIFO; the lead can use `--priority` to move ahead of
other waiting tickets, without interrupting a running job. `--run-id ID` (or
`CHALK_REMOTE_RUN_ID`) reuses the original ticket and result, including after an
ambiguous submission response. Registration finishes only after the whole snapshot
arrives. A default run ID is printed before registration.

Network drops automatically retry log reads from the last confirmed byte. After
Air sleep, a T3 restart, or Ctrl-C, run `scripts/gates/remote.sh --attach ID`.
Ctrl-C detaches; it does not cancel the ticket. There is no default queue expiry.
An explicit `CHALK_REMOTE_QUEUE_TIMEOUT_SECONDS` retains its old meaning (exit 76).
The M4 waits for at least 3 GiB of free + inactive + speculative memory and
the configured free disk floor before admission. Setup and gate runtime remain
bounded as before.

State lives under `~/.local/share/chalk-remote/v1` on the M4. A dispatcher owns
admissions and reaps dead worker descendants and their queue-owned
`/tmp/chalk-queue-work-*` checkouts when each ticket finishes. It exits
when idle. A later submission or attach restarts it; live log reads also restart a
dead dispatcher and record exit 137 for interrupted work. Logs and submission
files expire after seven days, on the next dispatcher start. Small result
tombstones remain so an old run ID cannot execute twice. Abandoned partial uploads
expire after an hour; an active upload holds a lease and cannot be reaped.

### Cut-over and undo

New submissions use three FIFO slots (`CHALK_REMOTE_SLOTS`, 1–100). Each job
receives `CHALK_REMOTE_SLOT`; the worker assigns distinct ports in blocks
`21000 + slot * 100 + role` and a private temp/state directory. PostgreSQL gate
and topology wrappers already allocate ephemeral ports and unique databases.
`--exclusive`, root/full gates, call-performance and performance-budget commands
wait for running slots to drain, then hold admission alone. A queued exclusive
ticket blocks later tickets; priority only changes waiting ticket order.

The client installs helpers by content hash and verifies the transfer before an
atomic rename. Each ticket carries its own worker script; deployment does not
rewrite running code. Legacy waiters keep their old shlock and drain one at a
time. A live legacy lock owner counts as one occupied slot. Ordinary jobs never
acquire that lock, even when all new slots are running. Only exclusive jobs take
it, and release it immediately when their process exits, before descendant
cleanup. The bounded guard waits for legacy tickets created before the exclusive
ticket before taking that lock; later arrivals cannot extend its barrier. Active legacy work always
finishes. New checkout names and port blocks avoid the old harness's process
veto and fixed ports. No legacy job is adopted, cancelled, or rewrapped.
FIFO applies among new tickets. After merge, lanes may voluntarily resubmit
legacy waiters through the new client to use the slots sooner.

To undo, restore the old client for future submissions. Let new tickets finish or
reattach with this revision; keep their state and helpers until they drain. No
shared runner or launchd service is replaced.

Tiny proofs (isolated queues; no shared heavy admission):

```sh
node --test scripts/gates/remote-queue.test.mjs
python3 scripts/gates/remote-queue-ssh-test.py agents-macmini
```

`root` installs Chromium. Set `CHALK_REMOTE_NEEDS_BROWSER=1` for custom `--`
commands that need it. `CHALK_REMOTE_REPO` overrides the local repository root.
See `scripts/gates/remote.sh --help` for the remaining `CHALK_REMOTE_*` settings.

## Dedicated-CPU timing runs (explicit opt-in)

Use `scripts/gates/remote-testbox.sh` only for timing runs that need a dedicated
c-8 box, including call-performance budgets. Testbox bills every box; ordinary
gates use the M4. The opt-in runner defaults to `c-8` for every command.

`scripts/gates/remote-testbox.sh <root|api|sync|recorder|-- command...>` runs on a
disposable Linux Droplet through the testbox skill.
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
45 minutes, recorder 20 minutes.
All runs default to `c-8` (8 dedicated CPU / 16 GB), including custom timing
commands. The measured region is `blr1`.
New shared images must be available there before use. This is an
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
