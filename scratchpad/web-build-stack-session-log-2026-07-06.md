# Web Build Stack Session Log - 2026-07-06

## Summary

- Updated the web app build stack from Vite 7-era dependencies to Vite 8.1.3.
- Replaced `vite-tsconfig-paths` with Vite 8 native `resolve.tsconfigPaths`.
- Updated TanStack Start dependencies:
  - `@tanstack/react-start` 1.168.27
  - `@tanstack/react-router` 1.170.17
  - `@tanstack/router-plugin` 1.168.19
  - `@tanstack/start-server-core` override 1.169.16
- Replaced the unsafe `nitro: latest` package specifier with explicit
  `nitro: 3.0.260610-beta`, matching the current npm `latest` tag without
  floating future installs.
- Updated exact React pins and workspace overrides to React/React DOM 19.2.7.

## Verification

- `pnpm install` completed successfully.
- `pnpm --dir apps/web run build` passed on Vite 8.1.3.
- `pnpm --dir apps/web exec tsc --noEmit --project tsconfig.json` passed.
- `pnpm run deps:syncpack` passed.
- `pnpm audit --prod --json` reported zero production vulnerabilities.
- OSV checks found no advisories for React, React DOM, or React Server
  Components packages at 19.2.7.

## Notes

- React/React DOM 19.2.4 did not show direct OSV advisories, but published
  React Server Components advisories cover 19.2.0 through 19.2.4 for
  `react-server-dom-*` packages. React 19.2.7 avoids that patch-line risk if
  server-side React/RSC support is enabled later.
- After the React 19.2.7 bump, Vite dev could expose the CommonJS
  `use-sync-external-store/shim/with-selector` file directly to the browser,
  causing a named-export SyntaxError from TanStack React Store. The web app now
  declares `use-sync-external-store` directly and pre-bundles the shim
  entrypoints with Vite `optimizeDeps.include`.
- `pod install` in `apps/mobile/ios` resolved the new React 19.2.7 pnpm paths
  but failed during React Native codegen with `TypeError: expand is not a
function` while processing `react-native-safe-area-context`; it left no
  tracked iOS changes.
- Full `pnpm run gate` is currently blocked by unrelated landing UI work:
  `apps/web/src/landing/icons.tsx` exports `ScreenIcon` and `SparkIcon` without
  known consumers.
- Browser smoke for the shim export issue passed, but the current landing route
  still emits a separate React hydration mismatch around `V1Aurora`.
