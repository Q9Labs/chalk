# Chalk Smart Gate

`pnpm run gate` is the single local and pull-request quality contract. It prints
the changed files, every selected command and its reason, and every skipped
check before execution. By default it runs automatic affected mode: it keeps
the current changed-file and reverse-dependent plan and does not infer a
shipment target.

Local pre-commit runs classify staged files. Pull-request CI classifies the
merge-base-to-HEAD diff using `GATE_BASE_REF` and `GATE_HEAD_REF`. Set
`GATE_FILES` to a comma- or newline-delimited list for a focused diagnostic
run. It remains a diagnostic override: target validation still applies to
those canonical paths, and the plan reports `source=explicit`.
`pnpm run gate -- --full` is the full safety net.

The classifier fails closed to full scope when gate definitions, root build
configuration, or an unknown path changes. Its routing tests run at the start
of every gate.

## Gate Modes

| Command                            | Use                     | Selection                                                                                                                    |
| ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run gate`                    | Automatic affected mode | Keeps the current changed-file and transitive reverse-dependent plan.                                                        |
| `pnpm run gate -- --target web`    | Web shipment            | Removes affected mobile-exclusive consumers. Keeps shared, non-platform, directly changed, and required upstream workspaces. |
| `pnpm run gate -- --target mobile` | Mobile shipment         | Removes affected web-exclusive consumers. Keeps shared, non-platform, directly changed, and required upstream workspaces.    |
| `pnpm run gate -- --full`          | Full safety net         | Selects the existing full-mode plan and applies no target.                                                                   |

Targets are a safety boundary, not a file allowlist. The `web` target starts
from `web`, `@q9labsai/chalk-react`, and `@chalk/sdk-web-consumer-e2e`. The
`mobile` target starts from `@q9labsai/chalk-mobile` and
`@q9labsai/chalk-react-native`. The planner walks each root's internal manifest
dependencies in `dependencies`, `devDependencies`, `optionalDependencies`, and
`peerDependencies`, so shared membership comes from package metadata. Affected
workspaces in neither target universe remain selected. Existing API, Sync,
contract, recorder, architecture, dependency, and other non-platform routes
remain selected when their paths change. Global hygiene, language, routing, and
secret checks remain selected in every mode.

The CLI accepts `--target web`, `--target=web`, `--target mobile`, and
`--target=mobile`. `GATE_TARGET=web` or `GATE_TARGET=mobile` provides the same
target for automation. A CLI target and `GATE_TARGET` may coexist only when
they match. A missing value, unknown value, repeated target, or `--full` with
either a CLI target or `GATE_TARGET` is an input error. Do not infer a target
from a branch,
changed file, package version, release mode, or current directory.

## Target Refusals

The gate refuses a target before starting any check when narrowing cannot be
proved safe. This includes a direct change to an opposite-platform-exclusive
workspace, a mixed web-and-mobile change set, an unknown or malformed target,
a CLI/environment conflict, a missing target root, duplicate workspace names,
malformed workspace metadata, or an unresolved `workspace:` dependency. A
target also cannot narrow a gate-definition, root dependency or workspace
configuration, unknown path, or other change that requires the full plan.
`scripts/gates/**`, including this README, remains a gate-definition change.
Explicit `GATE_FILES` paths that are empty, absolute, escaping, contain `.` or
`..` segments, or use duplicate separators that change meaning are also
invalid.

Every target error exits with status `2` before the first gate subprocess. The
error names the target, lists incompatible paths or configuration, explains
why narrowing is unsafe, and includes one `Run instead:` line. Mismatch,
unknown-target, malformed-input, missing-root, malformed-metadata, unresolved-
dependency, and CLI/environment-conflict errors say:

```text
Run instead: pnpm run gate
```

Full-required changes and `--full` combined with a target say:

```text
Run instead: pnpm run gate -- --full
```

The gate never falls back silently. Planning errors exit `2`; a failed check
keeps that subprocess's exit status. Existing Git and CI base-reference
errors keep their current behavior.

## Selection Rules

- Repository hygiene and diff-scoped secret scanning always run.
- The language vocabulary ratchet always runs. It compares case-insensitive,
  identifier-aware banned-term counts per surface with the committed baseline;
  decreases require `pnpm run language:ratchet:update` so each migration wave
  becomes the next locked baseline.
- Formatting, Fallow, Semgrep, workspace type checks, coverage tests, and
  builds follow affected source files and workspace dependents.
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

## Release Mapping

- A target-compatible web app or web-platform change may use
  `pnpm run gate -- --target web`.
- A target-compatible mobile app or React Native change may use
  `pnpm run gate -- --target mobile`.
- The synchronized `sdk` and `sdk+web` release modes change packages from both
  platform lanes plus release tooling and lock data. They use the existing
  single automatic `pnpm run gate`, which expands broadly for that diff. Never
  infer a web target from the release mode name.
- A shipment target controls validation only. It never changes which packages
  publish or which app deploys.
