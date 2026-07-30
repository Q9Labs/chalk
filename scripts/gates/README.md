# Chalk Smart Gate

`pnpm run gate` is the single local and pull-request quality contract. It prints
the changed files, every selected command and its reason, and every skipped
check before execution.

Local pre-commit runs classify staged files. Pull-request CI classifies the
merge-base-to-HEAD diff using `GATE_BASE_REF` and `GATE_HEAD_REF`. Set
`GATE_FILES` to a comma- or newline-delimited list for a focused diagnostic
run. `pnpm run gate -- --full` is the nightly and release safety net.

The classifier fails closed to full scope when gate definitions, root build
configuration, or an unknown path changes. Its routing tests run at the start
of every gate.

## Selection Rules

- Repository hygiene and diff-scoped secret scanning always run.
- Formatting, Fallow, Semgrep, test-presence, workspace type checks, coverage
  tests, and builds follow affected source files and workspace dependents.
- Tests run once with coverage; lint aliases do not repeat formatting or type
  checks.
- Go API changes run the complete language gate. Elixir Sync changes run the
  shared correctness profile: the full zero-skip PostgreSQL suite, Credo, the
  replayed v3 breaker, and focused Sync and whiteboard SDK tests. Both use a
  disposable, migrated PostgreSQL container that is removed on exit.
- Contract producers and consumers run generated-contract and SDK drift checks.
- Dependency inputs run Syncpack and OSV against tracked product lockfiles.
- Publishable packages run Publint and Are The Types Wrong only when affected.
- Architecture and recorder inputs run their standalone gates.

The full mode selects every rule. Separate nightly and release-candidate
workflows add multi-node partitions, PostgreSQL failover, sustained load,
process restart, and real-browser proof.
