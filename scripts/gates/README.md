# Chalk Quality Gate

`pnpm run gate` is the canonical local pre-remote quality contract for Chalk.
Humans and agents should run this same script before asking for a commit, PR, or
deployment. Lefthook also calls it from `pre-commit`.

`pnpm run gate` is intentionally non-mutating. It does not auto-format,
auto-fix, auto-stage, install hooks, or update generated contracts. If a check
finds drift, fix the underlying file with an explicit command and rerun the
gate.

`pnpm run review:commit` runs a synchronous Codex review of the commit that Git
just created. Set `CODEX_REVIEW_RUNS=2` or higher to run multiple reviews. Logs
are written under `.git/codex-reviews/<short-sha>/` so review output never
dirties the worktree.

`pnpm run gate:hygiene` fails on placeholder scripts, `--passWithNoTests`,
missing scripts referenced by `scripts/gates/commit.sh`, Turbo
`<NONEXISTENT>` task resolution, and generated OpenAPI stubs. This keeps the
gate honest before deeper checks run.

`pnpm run test:presence` requires newly added meaningful source files to have
nearby tests against `origin/master` by default. It excludes generated files,
declarations, barrels, assets, style-only files, config files, migrations,
scripts, and test helpers by explicit Chalk policy. Set
`TEST_PRESENCE_BASE_REF` or `TEST_PRESENCE_FILES` to change the comparison
scope.

The gate also runs Fallow, Semgrep, Gitleaks, OSV-Scanner, the focused
`apps/api` Go gate when present, Syncpack, OpenAPI drift/stub checks,
TypeScript, lint, tests, coverage, build, publint, and Are The Types Wrong.
Gitleaks scans the commit delta from `origin/master` by default; set
`GITLEAKS_BASE_REF` or `GITLEAKS_LOG_OPTS` to change that range.
