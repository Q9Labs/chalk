# Sync Fallow Health Session Log — 2026-07-12

## 2026-07-12 03:32 PKT

- Started a scoped structural-risk cleanup for the TypeScript sync runtime. The target is the repository Fallow health score, currently 88.6/90, without changing Fallow configuration, thresholds, suppressions, generated code, or whiteboard code.

## 2026-07-12 03:56 PKT

- Split the sync reducer validation, connection transition, recovery validation, and SyncClient state paths into small named units. Added `client-state.ts` for verified snapshot installation, event reduction, immutable replicas, and pending-command sizing. Public runtime behavior and exports remain unchanged.
- Corrected the server-frame boundary to the generated protocol’s 1,048,576-byte full snapshot-welcome cap. The prior 65,536-byte cap applies to client-to-server frames. Added an end-to-end generated-codec regression that completes valid replay and snapshot recovery frames above 65,536 bytes while retaining their contract limits.
- Corrected cumulative replay accounting to sum standalone encoded event bytes. Full replay-page envelopes still enforce the 262,144-byte page cap. Added a near-2,097,152-byte accounting regression where envelope-inclusive accounting would reject an otherwise eligible replay.
- Added same-basename reducer, connection, recovery, client, and client-state test coverage. Client-facing tests now assert public error exports through the package entry point, keeping shared error-module coupling below the health threshold.
- Verified `pnpm --filter @q9labsai/chalk-client lint`, `test` (17 files, 39 tests), and `build`; `pnpm run static:fallow:health` passes at 90/90; and `git diff --check` passes. The required `codex review --uncommitted` completed after inspecting the broad shared worktree but emitted no final verdict or findings.
