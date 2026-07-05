# SDK Surface Audit Session Log - 2026-07-05

## 20:00 PKT

- Removed the remaining `@q9labs/chalk-core` dependency/import surface from `apps/mobile` by moving the needed app helpers into mobile-local files.
- Kept `sdk-react` presentational only: removed old hooks/context/runtime files, preserved component JSX, and exposed narrow subpaths for atomic/composite/full/ui/utils.
- Made `@q9labs/facehash` root core-only while keeping React and React Native components behind `@q9labs/facehash/react` and `@q9labs/facehash/react-native`.
- Split React Native SDK platform entries and native multitasking helpers so Android, iPhone, iPad, iOS aggregate, and macOS imports have separate emitted surfaces.
- Removed web/root Excalidraw references; Excalidraw remains owned by `packages/chalk-whiteboard`.
- Synced `pnpm-lock.yaml` after dependency changes.
- Verification run: React SDK build, React Native SDK build, facehash build, UI build, whiteboard build, web build, mobile typecheck/tests, formatter check, and stale-reference scans for `bun`, `chalk-core`, React stubs, and package boundary markers.
