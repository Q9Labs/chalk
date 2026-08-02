# Phase 5 component vocabulary session log

- 2026-08-01 00:00 Asia/Karachi: Started Phase 5 on `v4/ubiquitous-language`; worktree was clean and dependency install completed successfully.
- 2026-08-01 00:00 Asia/Karachi: Read the root instructions, TypeScript SDK standards, writing/code standards, and `sdks/ubiquitous-language.md`; the latter is the naming authority for this migration.
- 2026-08-01 22:59 PKT: Renamed the React public component families and feature paths, retired the unused `SplitStage`, aligned layout and ControlBar props, and converted the public `/components` barrel to explicit named exports.
- 2026-08-01 22:59 PKT: Renamed React Native lifecycle components and all Android/iOS/macOS split files, aligned RN layout values, and renamed internal controller modules to match the canonical `ConferenceView`/`PreJoinScreen` vocabulary.
- 2026-08-01 22:59 PKT: Cascaded names through web/mobile consumers, package documentation, the changelog, and `sdks/ubiquitous-language.md`; React and React Native focused tests passed, and both package typechecks passed after the facehash prerequisite build.
- 2026-08-01 23:24 PKT: Completed the bounded review follow-up by preserving the canonical `Toast` type alongside the existing `Toast` value export and mapping retired sidebar layout selections to `focus`; the review re-launch failed at Codex app-server initialization after the initial review findings were fixed.
- 2026-08-01 23:33 PKT: Remote M4 verification passed client, React, and React Native typechecks/tests/builds plus web, mobile, and SDK consumer typechecks; changed-file formatting passed. The full gate and repository-wide format/lint stopped only on pre-existing/generated fallow and formatting findings, including `react-resizable-panels`.
- 2026-08-01 23:35 PKT: Corrected the changelog’s React Native layout row so the retired `sidebar` value is documented as `focus` plus Filmstrip, matching the canonical language and implementation.
