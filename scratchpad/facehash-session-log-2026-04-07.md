
## 2026-04-07 16:28:13 PKT
- Started packages/facehash implementation with shared scene/core port, web SVG renderer, and react-native-svg renderer.
- Swapped Chalk web/native avatar surfaces to the local workspace package for real integration coverage.

## 2026-04-07 16:31:29 PKT
- Resumed facehash implementation after interrupted verification; re-checking worktree and package wiring before the next fix pass.
- Added workspace project references and package export/build fixes so @q9labs/facehash resolves cleanly from sdk-react and sdk-react-native.
- Reverted Chalk web integration so only the new package + React Native wiring remain in scope for this pass.
- Switched RN consumption from @q9labs/facehash/react-native to the root package with a react-native conditional export so Metro can resolve it normally.
- Added packages/facehash to apps/mobile Metro watch folders so the new workspace package is visible to Expo/Metro.
- Metro log confirmed the new package was still hidden because metro.config.js had changed without a server restart; restarting the iOS dev-client server now.
- Switched the custom iOS launcher from a raw bundle URL to the Expo dev-server project URL to restore proper HMR/dev-client startup.
- Relaunched Android dev client against the Expo project URL over adb-reversed port 8088 to clear the stale 127.0.0.1:8081 runtime.
- Clean slate check: all simulators/devices were shut down, killed leftover dev-server processes, now scanning runtime code for an early reload path that could fire before HMR init.
- Removed the MobileMeetingScreen dynamic import from apps/mobile/App.tsx so Expo async bundle registration no longer fires before HMR setup.
- Re-exported FacehashNative from the root @q9labs/facehash entry so the RN root import resolves consistently for both Metro and TypeScript.
- Verified a clean iPhone relaunch without fresh HMRClient.setup errors after removing the dynamic MobileMeetingScreen import; testing iPad on the same runtime next.
- Verified fresh iPhone and iPad launches without new HMRClient.setup errors after removing the MobileMeetingScreen dynamic import.
- Booted Android emulator Chalk-Pixel-9 and relaunched the dev client against 127.0.0.1:8088 via adb reverse for a fresh post-fix verification.
- Replaced join-time async imports in sdk-react-native realtimekit-loader with synchronous require() so Expo does not create lazy JS chunks during room join.

## 2026-04-07 16:57:15 PKT
- Investigating iOS/iPad facehash blink regression where the eye transform appears to stay collapsed after the first blink; checking native SVG transform reset behavior.
- Fixed iOS native blink reset by always returning an explicit identity eye transform instead of clearing the transform prop, and added a regression test for the transform helper.
- Kept the native root entry separated from the web source index so package tests stay web-safe while RN still resolves the native root via package exports and tsconfig paths.

## 2026-04-07 20:14:11 PKT
- Restarting mobile dev stack after power outage: Metro/dev client plus iPhone, iPad, and Android emulator.
