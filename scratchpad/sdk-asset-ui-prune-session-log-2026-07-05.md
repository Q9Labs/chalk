2026-07-05 18:54:13 PKT

- Moved React SDK media ownership into `packages/ui/src/assets`.
- Removed the unused embedded React SDK `sound-data.ts` base64 audio module instead of moving it.
- Moved reaction emoji constants into `packages/ui/src/reactions.ts`.
- Pruned unused shared UI primitives so the package only keeps the currently consumed button/cn surface plus styles, assets, and reaction data.
- Removed React SDK asset exports/copy scripts and stale core/Cloudflare dependencies from the React package manifest.
- Cleared generated React SDK dist/coverage assets so a clean rebuild can prove the package no longer publishes media.

2026-07-05 follow-up

- Added narrow UI subpath exports for `@q9labs/chalk-ui/button` and `@q9labs/chalk-ui/utils`.
- Updated web imports to use those subpaths instead of the UI root barrel.
- Removed stale web public audio files and their legacy `/sounds/*` redirect; shared sounds now live only under `packages/ui/src/assets/sounds`.
- Updated `apps/web/.cta.json` to pnpm.
- Confirmed React Native has no source media assets to move in this pass.
- Removed React Native's stale dependency/imports on the gutted core package by adding local placeholder types/helpers under `packages/sdk-react-native/src/internal/core.ts`.
