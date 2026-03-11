# Codex Progress 2026-03-12

- `2026-03-12 00:19 PKT` explored native surface; removed iOS, Android, RN package, native scripts, and related workspace/docs wiring.
- `2026-03-12 00:24 PKT` native-removal gate: `bun install` and docs build passed; `lint` / `check-types` / `test` blocked by pre-existing `packages/sdk-react` issues in the dirty tree.
- `2026-03-12 00:33 PKT` explored secondary cleanup scope: `apps/e2e`, `apps/admin`, `apps/next-pages-demo`, and repo-local stress/load testing surfaces under `tests/`, scripts, docs, and repo skills.
- `2026-03-12 00:34 PKT` patched root config/docs/changelog to remove active references to e2e/admin/next-pages-demo/stress tooling before deleting those paths.
- `2026-03-12 00:37 PKT` deleted `apps/e2e`, `apps/admin`, `apps/next-pages-demo`, stress/load infra under `tests/`, stress result artifacts, stress runner scripts, and the repo-local `chalk-stress-testing` skill.
- `2026-03-12 00:38 PKT` refreshed `bun.lock`; verified active repo refs to removed apps/stress surfaces are gone outside historical files like `CHANGELOG.md`, `CLAUDE.md`, and `scratchpad/`.
- `2026-03-12 01:05 PKT` fixed the shared Picture-in-Picture render loop in `@q9labs/chalk-react` by hoisting stable default props in `MeetingRoom` and `PreJoinLobby`, and by making shared PiP registration idempotent for unchanged registrations.
- `2026-03-12 01:07 PKT` verified `MeetingRoom` and `PreJoinLobby` shared PiP regression tests pass; full `packages/sdk-react` test run now clears the old runaway and stops later on unrelated existing failures in `TourTooltip` and `ParticipantList`.
