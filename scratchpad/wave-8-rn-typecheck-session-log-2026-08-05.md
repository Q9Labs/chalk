# Wave 8 React Native typecheck session log

## 2026-08-05 15:12 PKT

- Diagnosed the React Native check-type failure in
  `sdks/typescript/react-native/src/test-support/test-renderer.ts`. The package
  already declares `@types/node`, and its package-local TypeScript 5.9.3 run
  passed. The root `pnpm exec tsc` resolves the workspace TypeScript 6.0.3
  (with the existing TypeScript 7 alias also installed), whose invocation does
  not auto-include the package-local Node type package when the project is
  selected from the workspace root. The resulting TS2591 errors covered
  `node:module`, `node:path`, and `process`.

- Added `compilerOptions.types: ["node"]` to
  `sdks/typescript/react-native/tsconfig.check-types.json`. This is the narrow
  check-only configuration fix: it makes the existing Node typings explicit
  without adding dependencies or exposing Node globals through the package's
  React Native build configuration.

- Verification passed:
  `pnpm exec tsc --project sdks/typescript/react-native/tsconfig.check-types.json
--noEmit --pretty false` (root invocation, exit 0);
  `pnpm exec oxfmt --check sdks/typescript/react-native/tsconfig.check-types.json`;
  `pnpm run language:ratchet`; and
  `git diff --check -- sdks/typescript/react-native/tsconfig.check-types.json`.

- No files were staged or committed, no unrelated paths were touched, and no
  persistent process was started.

## 2026-08-05 15:13 PKT

- The package-local command `pnpm --filter @q9labsai/chalk-react-native run
check-types` also passed after the explicit Node type inclusion.

## 2026-08-05 19:09 PKT

- Reproduced the clean mobile export failure: Expo/Metro could not resolve
  `@chalk/diagnostics-contracts` from the client runtime because the workspace
  package was not in the mobile resolver's focused watch and alias set. Added
  the canonical workspace package root to `watchFolders` and mapped the public
  package name through `resolver.extraNodeModules` in
  `apps/mobile/metro.config.js`. The source package remains the only runtime
  implementation; no source copy or bundler alias to an internal file was
  added.

- Added the contracts build to `apps/mobile`'s existing
  `prepare:native-dependencies` sequence so a fresh workspace without package
  `dist` output produces the published package entrypoint before Metro runs.
  Extended `apps/mobile/metro.config.test.ts` with a focused assertion that the
  watch folder and package alias both point at the canonical workspace root.

- Clean/no-dist proof passed after moving the pre-existing contracts `dist`
  directory aside: `pnpm --filter @q9labsai/chalk-mobile run build` rebuilt the
  diagnostics contracts, client, Facehash, whiteboard, and React Native package,
  then exported Expo iOS and Android bundles successfully. The generated mobile
  exports and temporary backup were removed and verified absent afterward.

- Focused checks passed:
  `pnpm --filter @q9labsai/chalk-mobile run check-types`;
  `pnpm --filter @q9labsai/chalk-mobile exec vitest run metro.config.test.ts`
  (2 tests); and the prior React Native typecheck, formatting, ratchet, and
  diff checks. No files were staged or committed and no process remains.

## 2026-08-05 19:25 PKT

- Closed the mobile lifecycle gap by adding the `prestart:raw` package hook.
  Both the root `pnpm --filter @q9labsai/chalk-mobile run start:raw` path and
  the logged `pnpm --filter @q9labsai/chalk-mobile run start` path now invoke
  `prepare:native-dependencies` once through pnpm's lifecycle, while `start`
  continues to delegate to `start:raw` without embedding a second preparation
  command.

- Strengthened `apps/mobile/metro.config.test.ts` beyond config-shape checks.
  The test copies the diagnostics package into a unique no-dist fixture,
  rebuilds its published `dist/index.js` with the workspace toolchain, links it
  under a simulated chalk-client `node_modules`, and runs Metro's real resolver
  for both `ios` and `android`. Both platforms resolve the built package entry.
  The test also asserts the lifecycle hook wiring.

- Focused Metro tests passed 4/4 in 18.5s. A clean root `start:raw` smoke ran
  the preparation chain once, reached `Waiting on http://localhost:8081`, and
  stopped cleanly. The logged `start` smoke likewise showed one
  `prestart:raw`, reached Metro readiness, and stopped with the expected SIGINT
  exit; its generated dev log was removed. Mobile typecheck, oxfmt, language
  ratchet, and targeted diff checks passed. No persistent process or fixture
  remains, and no files were staged or committed.
