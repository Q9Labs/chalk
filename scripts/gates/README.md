# Chalk Gate on q9gate

`pnpm gate` runs tracker generation checks, then `q9gate run` with Chalk's checks declared as custom lanes in `gate.config.ts`; `pnpm gate:full` adds `--full`. Locally each gate runs single-threaded (`GOMAXPROCS=1`, `VITEST_MAX_WORKERS=1`, `ERL_FLAGS='+S 1:1'`, q9gate concurrency 1) so it fits a small machine; an already-set variable replaces the default. "gate.report.json" records every selected and skipped lane.

Every profile first runs `doclint.mjs`. The pre-commit hook runs `pnpm gate:fast` (doc checks, tracker check, and the `scope`, `format`, `hygiene` and `secrets` lanes on staged files). The `generated` lane is too slow for the hook, so run `pnpm run check:generated` yourself after editing a generator input. A run with nothing in scope fails in the `scope` lane; set `GATE_ALLOW_EMPTY=1` only when that is intended.

## The Gate workflow

`.github/workflows/gate.yml` runs on every pull request, merge queue group, week (Monday) and manual dispatch. `Select gate jobs` runs `node scripts/gates/chalk-gate-plan.mjs --ci-jobs <base-ref>`, which uses the same plan as the lanes to pick the jobs a change needs: the API gate, the Sync gate and root lane groups. Groups run as separate jobs, at most eight at a time, so one run holds at most 10 of the organisation's 20 hosted-runner slots (four held the last groups of a full run waiting for 6 to 10 minutes while the slots were free). The SFU lane has its own group because it alone took 176 of the 408 seconds the checks group needed. `Root gate` passes only when every selected group passed, and `Sync gate` only when its two parts (the server tests and the client proofs against it) passed; a job the planner skips counts as passed. When the planner cannot select jobs (for example the base does not resolve), every job and lane runs with `--full`. Weekly and manual runs always run everything.

**Pull request or queue.** `GATE_EVENT` carries the event name to the planner. A pull request selects by changed inputs only: a test file is not an input of the dashboard engine or the call lanes, and only `.github/workflows/gate.yml` and `.github/workflows/cache-warm.yml` count as gate behavior among the workflows, so an edit to another workflow runs the `workflow-graph` tests instead of the full gate. A merge queue group keeps the wider rules and runs the dashboard engine, the dashboard refresh proof and the call lanes for every change beyond documentation, so what a pull request skipped is proven before master receives the commit. The refresh proof waits out the real five-minute media-access lifetime, so it is its own lane: a pull request selects it only when it changes the refresh inputs (the web server, the dashboard source and its proofs, access grants), and the HTTP proof in `dashboard-engine` is what the pull request waits for. Local runs use the wider rules too.

Which group a lane belongs to, and which file edits narrow the plan, is in `chalk-gate-plan.mjs`. Editing most other files under `scripts/gates/`, or `package.json`, selects the full gate.

**Merge queue.** A group diffs against its own base commit, and master receives only a commit whose group passed. A passed pull request run saves a `gate-proof` artifact that names the head and base it tested and the jobs it ran. The group's `Select gate jobs` step finds the proof for the pull request's head, lists the files master gained since that base (the drift), and skips each job the proof covers whose inputs the drift did not change, so the group repeats only what could have changed. The checks group, a partial set of leak shards, and any drift that changes the Gate itself are never skipped, and a missing, stale or unreadable proof means the group runs everything. Skipped groups appear in the step log as `Shared with the pull request's Gate run`. The proof comes from the same workflow file the pull request ran, so it is as trustworthy as the required checks themselves; `scripts/releases/release.py` accepts that group's run as the Gate of the landed commit. A commit that reaches master without a group (an administrator bypass or a direct push) has no Gate run until someone dispatches one. Auto-merge is off because the queue is a ruleset rule, so `gh pr merge` cannot enqueue. Enqueue a pull request whose required checks passed with the `enqueuePullRequest` mutation, pinned to the head you checked so a later push cannot join the group unseen:

```sh
gh api graphql -f id="$(gh pr view <pr> --json id --jq .id)" -f head="$(gh pr view <pr> --json headRefOid --jq .headRefOid)" -f query='
  mutation($id: ID!, $head: GitObjectID!) {
    enqueuePullRequest(input: {pullRequestId: $id, expectedHeadOid: $head}) { mergeQueueEntry { id } }
  }'
```

A push after enqueueing drops the entry: fix the cause and enqueue again.

**Vulnerabilities.** On a narrowed pull request, when OSV-Scanner or govulncheck finds something, the same scan runs on the merge base (`GATE_VULN_BASE_REF`; merge queue groups use `GATE_OSV_BASE_COMMIT`) and `new-vulnerabilities.mjs` fails the pull request only for a finding the base lacks, that is, a package version the pull request changed. A new advisory against a package nobody changed fails the Daily vulnerability scan instead. An all-zero base SHA has no baseline and fails on all findings. That workflow runs OSV-Scanner and govulncheck for the API module without a baseline, stays red on any finding, and reports to the standing `security-osv-daily` issue.

**Caches.** Only `.github/workflows/cache-warm.yml`, on pushes to `master`, saves the Go build caches, so pull requests and queue groups start from master's caches and do not evict each other's. The API job sets `-count=1` because a cached Go test result would not see a migration or database change.

## Checks register

`checks.json` is the one list of every check Chalk runs: each Gate lane, each workflow job, the commit hook command and each scorecard budget group. `gate.config.ts` builds its custom lanes from the Gate entries, and the planner throws for a task with no entry, so a lane cannot exist without one. Each entry states the failure it exists to catch in one sentence, its owner (`owner`, a feature or area name, never a person), where it runs (`runs`), what it blocks (`blocks`), its median minutes, and its record in the CI timing audit sample (`caught`, `noise`, `never-failed` or `unmeasured`) with the numbers behind it.

`blocks` takes one of six values. `merge` is a required context or a lane inside one. `release` stops a cut or Promote. `commit` is the hook. `alert` opens an issue or pages someone, for a monitor that no change causes. `action` is work that is not a check, such as a build, a deploy or a cache warm. `advisory` is red on a pull request but is not a required context, and it needs a `reason` that says why it stays and why it cannot block. A check that blocks nothing and has no reason is deleted.

`node scripts/gates/check-register.mjs` runs as the `register` lane and fails when a workflow job, a Gate lane, a `lefthook.yml` command or a budget group has no entry, when an entry names something that no longer exists, when an entry is malformed, or when a budget has `gate: false`. To add a check, add its entry in the same change. To remove one, delete both.

Four workflows stay advisory because only a change to the repository ruleset can make them block, and that needs the repository owner: `mobile-ci` (the unsigned native builds need macOS and a long runner), `codeql` (findings go to the Security tab), `sdk-web-consumer-e2e` (Firefox and WebKit packed-consumer runs, beyond the Chromium run in the Gate) and `release-contracts` (the only pull request cover for the release workflow inputs).

**Scorecard budgets.** Every budget in `perf/budgets.json` gates. `web.route`, `web.laptop` and `web.phone` fail the pull request in the Gate. `chalk_sfu.action` holds the nightly cut on a breach, and `proof.leave_median_ms` stops Promote after a rerun. `cf_sfu.action` fails only the Cloudflare `latency` job (so that night records no history card) and opens no issue, because the Cloudflare plane is not on the release path. A metric that nothing produces has no budget, and a budget cannot be set to warn.

## Scope and selection

`pnpm gate:explain <path>` asks q9gate why a path selects lanes. `pnpm gate -- --base <ref>` compares `<ref>...HEAD`; `--files <path>` (repeatable) or `GATE_FILES` gives an explicit list, and those worktree files are also scanned for secrets. `--lane <id>` runs one lane. Gate-definition or unknown files fail closed to the full plan; q9gate counts every path as source, so Chalk's planner alone decides which paths are unknown.

`pnpm gate -- --target web|mobile` scopes to a shipment. Chalk's planner keeps dependency-aware workspace exclusions and rejects incompatible mixed-platform changes. Do not infer a shipment target from a branch, release mode or directory.

Documentation-only changes keep the hygiene, secrets, feature-map, generated-output and format checks and do not force unrelated service or workspace checks. Workspace builds run through Turbo with their dependency closure and are forced, never trusted from cache. The boundary gate rejects relative reach-through into another workspace's private source and packages or SDKs importing applications; it does not enforce intra-workspace cycles or orphans. `infrastructure/managed-episode` and `infrastructure/nightly` run the API, Sync and recorder gates because those tests read them.

## Design-token ratchet

The `design-tokens` lane counts raw color, spacing, radius, font-size and shadow values in web, UI, SDK and mobile source against `design-tokens-baseline.json`. A new raw value fails. A removed value also fails until the baseline shrinks, so the removing change runs `pnpm exec q9gate accept-baseline design-tokens --message "shrink design-token baseline"` and commits the smaller file. A justified exception takes a `token-ratchet-ignore: <reason>` comment on the line or the line above.

## Test policy checks

The `ast-grep` lane rejects a test that mocks a module of this repository, whatever name the mock call hangs on (`vi`, an alias of it, node:test's `mock`) and whether the path is a string, a template or `import(...)`, in any file. An `ast-grep-ignore` comment without a rule name, or one naming that rule, fails the lane, because ast-grep would honor it and hide the mock. The `mock-calls` lane counts assertions on mock calls (matchers, reads of `fn.mock.calls`, and node:test's `fn.mock.callCount()`) per package in every JavaScript and TypeScript test file and fails when a count differs from `mock-call-baseline.json`: a rise is a new assertion, and a fall means the baseline is stale. `node scripts/gates/mock-calls.mjs --update` lowers the baseline after a drop and refuses to raise it. The lane also reads the baseline on the merge base with `GATE_BASE_REF` (default `origin/master`) and fails when the committed one is higher, or when that base cannot be read. The policy is in [CODING_STANDARDS.md](../../CODING_STANDARDS.md).

## Heavy runs on Instabox

Commit and push first: `box run` fetches the pushed HEAD, not working-tree edits. Run Linux gates and browser suites on Instabox, never on the laptop. The machine is deleted when the command ends. `--size 2x4` is half the price of the default and enough, since every full-gate lane peaks at or below 2.5 GiB; keep the single-worker settings (`instabox-run.sh` sets `VITEST_MAX_WORKERS=4` because most test files wait on timers).

```sh
box run --size 2x4 -- 'bash scripts/gates/instabox-run.sh --browser'
box run --size 2x4 -- 'bash scripts/gates/instabox-run.sh apps/api/scripts/gate.sh'
box run --size 2x4 -- 'bash scripts/gates/instabox-run.sh scripts/gates/with-postgres.sh -- apps/sync/scripts/gate.sh'
```

`instabox-run.sh` installs locked dependencies, mounts data-disk scratch at `/tmp` (the snapshot's 4 GB tmpfs cannot satisfy the queue proofs' 8 GB admission floor, and one mount preserves hard links), installs Chromium with `--browser`, and runs `pnpm gate:full` when given no command. Use `with-postgres.sh --` for Sync runs; the API gate manages its own database. Tool versions are pinned in `.tool-versions`, `apps/api/go.mod` and the CI setup actions. The [performance runbook](../../docs/performance-budget.md) separates diagnostic timings from calibrated budgets; do not enforce old timing limits on a new runner without re-measuring.

## Documentation checks

`node scripts/gates/doclint.mjs` checks maintained Markdown for missing local links and literal repository paths, undeclared package scripts in package-manager commands, and retired runner guidance. Fixture documents, changesets and changelogs are exempt. An example path needs an exact document/path entry and a reason in `doclint-examples.json`; never allow whole directories. The SDK effect rule takes one adjacent, reasoned suppression per call, never a whole file.
