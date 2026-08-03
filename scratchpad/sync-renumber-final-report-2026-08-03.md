# Sync v1 renumber final report

Status: Done.

The inherited large uncommitted diff was audited against `scratchpad/version-archaeology-codex-2026-08-03.md`. Intended deletions and renumbering work were kept, stale or out-of-scope remnants were fixed, and generated Elixir and TypeScript output was regenerated and reconciled. The worktree remains uncommitted and unstaged as requested; the orchestrator owns the commit.

## Legacy deletion

The old Sync architecture and its support surface are gone. This includes the Elixir `rooms/room.ex` and `rooms/room_server.ex` modules and tests, `dev_tools` and trace modules, `priv/lab`, scripted-stateholder support, the old generated-contract test, the old breaker implementation and support tree, the old v3 breaker tree and tests, v3 transport tests, the `room_actions_v1` fallback behavior and tests, and the old v3 TypeScript client, generated export, wire script, schema, fixtures, docs, and configuration references.

The canonical files `apps/sync/lib/chalk_sync/protocol.ex`, `transport/socket.ex`, and `contract/generated.ex` now hold the active v1 implementation. They are not legacy modules left behind: their modules and generated identifiers are `ProtocolV1`, `SocketV1`, and `GeneratedV1`.

## Renumbering

The logical old-to-new changes are:

- `contract/schema/sync-v3.json` → `contract/schema/sync-v1.json`, with v1 protocol value, `/v1/sync`, state schema version 1, and `chalk-sync-state-v1`.
- `contract/schema/fixtures/sync-v3` → `contract/schema/fixtures/sync-v1`.
- `GeneratedV3`, `ProtocolV3`, and `SocketV3` → `GeneratedV1`, `ProtocolV1`, and `SocketV1`.
- TypeScript `src/sync/v3-*` → `src/sync/v1-*`; `generated/sync-v3.ts` → `generated/sync.ts`; `createV3SyncClient` → `createV1SyncClient`.
- `sync_breaker` and `sync_breaker_v3` → `sync_breaker_v1`, including the release task, support code, fixtures, scripts, and docs.
- `/v3/sync` and v3 Sync URL/config names → `/v1/sync` and v1 names, including local, mobile, web, meeting-broker, and SDK consumer surfaces.
- v3-carrying Sync trace and telemetry names → the current v1/generic names, with the success and failure paths covered by the observability tests.

No HTTP API v1 route, whiteboard v1 contract, webhook v1 event, room/session/meeting vocabulary, or database field was renamed. Existing API database identifiers such as `sync_v3_*` and the declarative migration filename remain unchanged by design; the durable Sync state value and digest were reset to 1 as required. `docs/contract-codegen.md` describes production Sync protocol version 1 frames and makes no claim that v2 frames existed.

## Verification

The full remote gate ran on `agents-macmini` from an exact scratch checkout and passed with `Smart gate passed`:

- `pnpm install --frozen-lockfile`: pass.
- `pnpm --filter @q9labsai/chalk-assets... --filter @q9labsai/facehash... --filter @q9labsai/chalk-ui... --filter @q9labsai/chalk-whiteboard... --filter @q9labsai/chalk-client... --filter @q9labsai/chalk-react... --filter @q9labsai/chalk-react-native... --workspace-concurrency=1 run build`: pass.
- `env PATH=/tmp/chalk-sync-renumber-tofu-bin.20260803:$PATH GO=/opt/homebrew/bin/go GOCACHE=/tmp/chalk-sync-renumber-gocache npm_config_workspace_concurrency=1 pnpm run gate -- --full`: pass. Routing passed 14 tests; architecture passed 10 tests; formatting, hygiene, gitleaks, Fallow, Semgrep, OSV, API, Sync, contracts, dependency policy, type checks, coverage tests, builds, recorder validation, publint, and `attw` all passed.
- API gate: all migrations applied to disposable Postgres, Go tests, vet, staticcheck, vulnerability checks, and lifecycle smoke passed.
- Sync gate: compile with warnings as errors, Credo over 191 source files and 3,488 mods/functions, `357 passed, 4 excluded`, SyncEngine v1 breaker passed, replay passed twice, Sync subset 92 tests, and whiteboard subset 22 tests.
- Contract gate: current ContractIR, 53,796 bytes with SHA-256 `bfa84d59ec5af0a426332d74290effb3b7d2623e878a46db8f8f8482d330da40`; webhook contract 15 fixtures, 2 signatures, and 8 journey events; full codegen tests 24 passed.
- Affected workspace coverage tests passed with these reported counts: transcription 34, uptime 13, facehash 5, UI 2, whiteboard 31, client 323, contract-codegen 24, meeting-broker 8, React 62, React Native 132, mobile 15, and web 37.
- Local focused checks also passed: `pnpm --filter @q9labsai/chalk-client... --workspace-concurrency=1 run build`, client typecheck and 55 files and 323 tests, React Native typecheck and 62 files and 132 tests, `MIX_ENV=test mix compile --warnings-as-errors`, `apps/sync/scripts/gate.sh basic`, focused Sync codegen with 10 tests, `pnpm run contract:check`, and `git diff --check`.
- Local `pnpm run recorder:gate` passed with OpenTofu v1.12.3, its six config tests, and provider mutation disabled. The remote host lacked OpenTofu, so the remote full-gate recorder command used a task-local `tofu` name pointing to its installed Terraform binary; the recorder checks themselves passed.

## Skips and uncertainty

The SDK consumer E2E command passed its non-browser checks but reported that Chromium was skipped because the local Playwright binary was not installed. No browser UX flow was required for this protocol-only change. The one required `codex review --uncommitted` attempt could not launch because the in-process app-server client returned `Operation not permitted`; it was not retried, so it provides no review coverage.

The valid local `MIX_ENV=test mix test --no-start` invocation was not used as a gate because it intentionally omits the application and database and produced the expected setup failures; the started test run and the remote zero-skip Sync gate passed. Remote task checkouts, caches, the Go cache, the OpenTofu shim, and service artifacts were removed and verified. The local sandbox retained two recoverable temporary directories outside the worktree, `/private/tmp/chalk-sync-renumber-rn-embedded-20260803` and `/private/tmp/chalk-sync-renumber-pnpm-store-20260803`, after refusing their deletion; no generated artifact or cache remains in the repository.
