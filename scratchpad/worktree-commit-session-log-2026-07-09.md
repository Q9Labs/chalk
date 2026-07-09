# Worktree Commit Session Log - 2026-07-09

## 14:53 PKT

Started worktree commit and push session on `master`.

Initial status shows grouped changes across API codegen/OpenAPI, web landing and SDK preview surfaces, SDK generated files, gate scripts, session logs, and `lobby-animations/`.

## 15:02 PKT

Read API-local instructions and Go code standards because the worktree includes API Go files.

Formatted changed API Go files with `/usr/local/go/bin/gofmt`; gopls diagnostics reported no diagnostics for the changed API files.

## 15:06 PKT

Ran `pnpm run check:sdk-generated`; it passed.

Ran `pnpm run gate`; it failed in `static:fallow` on unused generated/schema files, missing `effect` dependency, duplicate `Participant` exports, and duplication/complexity findings in the codegen and scratchpad generator copies.

## 15:20 PKT

Added `effect` as a root dependency after checking npm metadata and `pnpm audit --prod`.

Fixed the Fallow blockers by exporting reachable SDK React components/types and marking generated/codegen artifacts as intentional entries.

Ran `pnpm run static:fallow`; it passed.

## 15:35 PKT

Full gate next failed in `security:osv` on Go stdlib 1.25.11 advisories and an unfixed `golang.org/x/crypto/openpgp` advisory.

Updated `apps/api/go.mod` to `go 1.25.12` and added an API-local `osv-scanner.toml` ignore for `GO-2026-5932`, scoped to the unused `openpgp` package and expiring on 2026-10-09.

Ran `pnpm run security:osv`; it passed.

## 2026-07-09 15:55 PKT

- Resumed after interruption with the same goal: commit the whole worktree in sensible groups and push.
- Found the remaining blocker: SDK drift check and formatter disagreed on generated OpenAPI JSON formatting.
- Updated SDK generate/check scripts so generated artifacts are formatted consistently before diffing.

## 2026-07-09 16:00 PKT

- Ran `pnpm run gate`; it passed end to end, including API gate, generated SDK drift, spelling, presence, format, typecheck, lint, tests, coverage, build, publint, and attw.
- Preparing grouped commits and push.
