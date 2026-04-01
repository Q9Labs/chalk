## 2026-03-31

- 12:16:11 PKT - Investigated Expo iOS launch failure: `xcrun simctl boot 5FE1387F-6F70-40FB-8E29-C179F44A7848` returned code 148 with `Invalid device or device pair`.
- 12:16:11 PKT - Confirmed current available simulators via `xcrun simctl list devices available`; stale UDID was not present. Valid `iPhone 17 Pro` UDID found: `4D3391DF-58C7-4682-89BE-3596DE886850`.
- 12:16:11 PKT - Checked repo and Expo-local metadata. `apps/mobile/.expo/devices.json` did not contain the stale UDID.
- 12:16:11 PKT - Identified root cause in macOS Simulator preferences: `defaults read com.apple.iphonesimulator` showed `CurrentDeviceUDID = 5FE1387F-6F70-40FB-8E29-C179F44A7848`.
- 12:16:11 PKT - Updated `com.apple.iphonesimulator` `CurrentDeviceUDID` to live simulator `4D3391DF-58C7-4682-89BE-3596DE886850`.
- 12:16:11 PKT - Verified valid simulator boots with `xcrun simctl boot 4D3391DF-58C7-4682-89BE-3596DE886850`.
- 12:16:11 PKT - Verified Expo advances past device selection with `pnpm --dir apps/mobile exec expo run:ios --device "iPhone 17 Pro" --no-install --no-bundler`; output reached `Using --device 4D3391DF-58C7-4682-89BE-3596DE886850` and `Planning build`.
- 12:22:12 PKT - Investigated follow-up Expo error: `No development build (ai.q9labs.chalk.mobile) for this project is installed`.
- 12:22:12 PKT - Confirmed bundle identifier from `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj` is `ai.q9labs.chalk.mobile`.
- 12:22:12 PKT - Confirmed booted simulator did not have `ai.q9labs.chalk.mobile` installed via `xcrun simctl listapps booted`.
- 12:22:12 PKT - Verified `apps/mobile/ios` native project and `Pods` are present locally; `expo run:ios --device "iPhone 17 Pro" --no-bundler` entered normal install flow and progressed to `Installing CocoaPods...`.
- 12:24:30 PKT - Investigated `xcodebuild` exit code 70. `xcodebuild -showdestinations` reported no eligible iOS destination because `iOS 26.4 is not installed`.
- 12:24:30 PKT - Confirmed local Xcode version is `26.4` while installed simulator runtimes only include `iOS 26.2`, so Expo cannot target the booted simulator until the matching `iOS 26.4` platform/runtime is installed.
- 12:29:00 PKT - Investigated Hermes build failure from `apps/mobile/.expo/xcodebuild.log`. The failing script used `NODE_BINARY=/opt/homebrew/Cellar/node/25.6.1/bin/node` from `apps/mobile/ios/.xcode.env.local` and aborted with `Abort trap: 6`.
- 12:29:00 PKT - Verified the same Hermes replacement script succeeds when executed with the current `node` on PATH.
- 12:29:00 PKT - Updated local Xcode env override `apps/mobile/ios/.xcode.env.local` to `export NODE_BINARY=/opt/homebrew/bin/node`.
- 12:29:00 PKT - Re-ran `pnpm --dir apps/mobile exec expo run:ios --device "iPhone 17 Pro" --no-bundler`; build progressed past `[Hermes] Replace Hermes for the right configuration, if needed` and continued into normal pod compilation, confirming the Hermes blocker was resolved.
- 13:16:00 PKT - Investigated iOS blank white screen. Simulator logs and screenshots showed the app stuck on the Expo splash/dev client shell while fetching the development bundle from Metro.
- 13:16:00 PKT - Confirmed Metro bundle requests were timing out on `http://192.168.18.245:8081/apps/mobile/index.ts.bundle?...transform.bytecode=1...`; app logs reported `Could not connect to development server.` after the request timed out.
- 13:16:00 PKT - Added a Metro config improvement in `apps/mobile/metro.config.js` to watch only `apps/mobile`, `packages/sdk-core`, `packages/sdk-react-native`, and workspace `node_modules` instead of the entire monorepo.
- 13:16:00 PKT - Checked local Node runtimes. Homebrew `node@22` exists (`22.22.0`) but is currently broken on this machine due missing `simdjson` dynamic library, so Metro remained on `/opt/homebrew/bin/node` and `.xcode.env.local` was restored to that working path to avoid breaking Xcode builds.
- 13:56:00 PKT - Repaired local `node@22` by reinstalling `simdjson` and `node@22`, then updated `apps/mobile/ios/.xcode.env.local` to `export NODE_BINARY=/opt/homebrew/opt/node@22/bin/node` so native builds use the stable Node 22 binary.
- 13:56:00 PKT - Switched iOS native config from Hermes to JSC in `apps/mobile/ios/Podfile.properties.json` and reinstalled pods. Also aligned Expo config by setting `ios.jsEngine = "jsc"` in `apps/mobile/app.config.ts`.
- 13:56:00 PKT - Rebuilt and reinstalled the iOS dev client successfully with `pnpm --dir apps/mobile exec expo run:ios --device "iPhone 17 Pro" --no-bundler`.
- 13:56:00 PKT - Confirmed a separate localhost transport issue: Expo Metro started in `--localhost` mode but listened only on IPv6 loopback (`[::1]:8081`), while the simulator tried IPv4 `127.0.0.1:8081`, producing `Connection refused` in device logs.
- 13:56:00 PKT - Verified the simulator no longer requests the old LAN/Hermes URL after the config alignment; it now fails against `http://127.0.0.1:8081/...`, which narrowed the remaining blocker to local Metro reachability/performance.
- 13:56:00 PKT - Created a temporary local IPv4-to-IPv6 bridge for ports `8081-8083` with a small Node TCP proxy so the simulator can reach Metro while Metro is bound only to `[::1]`.
- 13:56:00 PKT - With the IPv4 bridge in place, the simulator advanced from immediate `Connection refused` to active `Bundling ...` progress again, confirming the address-family mismatch was real. Metro still stalls near the end of the first large iOS bundle, so first-load bundle generation remains the last unresolved blocker.
- 14:14:00 PKT - Identified the main Metro performance blocker in the JS graph: mobile code was importing icons from the giant `@hugeicons/core-free-icons` barrel (`dist/cjs/index.js`, ~6.1 MB). Replaced all mobile and `sdk-react-native` icon imports with direct `@hugeicons/core-free-icons/dist/esm/*` imports and added a local type shim in `apps/mobile/src/types/hugeicons-direct.d.ts`.
- 14:14:00 PKT - Verified the fix by running `pnpm --dir apps/mobile exec expo export --platform ios`; export now completes successfully in ~2.5s and writes a full iOS bundle instead of hanging at `99.9%`.
- 14:14:00 PKT - Confirmed the remaining simulator-only issue is address selection, not bundling. `curl http://[::1]:8081/apps/mobile/index.bundle?...` now returns `200` with a 24 MB bundle quickly, while `http://127.0.0.1:8081/...` still times out or fails depending on the bridge path.
- 14:14:00 PKT - Confirmed the iOS dev client can successfully talk to Metro over IPv6 by opening `exp+chalk-mobile://expo-development-client/?url=http%3A%2F%2F%5B%3A%3A1%5D%3A8081`; simulator logs show successful `200` responses from `http://[::1]:8081/`.
- 14:46:00 PKT - Confirmed Expo Dev Launcher on this machine still crashes on the IPv6 websocket path and still advertises the internal Metro port when given the root LAN URL, so the reliable simulator path needs a bridged IPv4 endpoint plus a direct bundle URL.
- 14:46:00 PKT - Verified a working bridge setup by running Expo on `localhost:8088`, proxying `0.0.0.0:8081-8083` to `[::1]:8088-8090`, and prewarming the iOS bundle through `http://192.168.18.245:8081/apps/mobile/index.bundle?...`.
- 14:46:00 PKT - Observed the cold iOS dev bundle now completes in `81675ms`, which is slow but no longer deadlocked. A warm reload then completed in `122ms`.
- 14:46:00 PKT - Confirmed the app renders successfully after the warm reload. Simulator screenshot `/tmp/chalk-ios-warm-reload-XXXXXX.png` shows the Chalk home screen with the `New meeting` CTA visible.
- 14:46:00 PKT - Added `apps/mobile/scripts/start-ios-sim-dev-client.mjs` plus package script `pnpm --dir apps/mobile run start:ios-sim` to automate the bridged Metro launch, bundle prewarm, and simulator deep link using the direct iOS bundle URL.

## 2026-03-31 15:10 PKT
- Added iOS simulator runtime flag via `apps/mobile/ios/Chalk/ChalkRuntimeInfo.m` and wired it into the native project.
- Added simulator-safe media guards in `@q9labs/chalk-react-native` so prejoin preview stays off, join forces `videoEnabled=false`, and the in-meeting camera button is disabled on iOS Simulator.
- Rebuilt the iOS app successfully with the new native module compiled (`ChalkRuntimeInfo.m`).
- Verification: `pnpm --dir apps/mobile exec tsc --noEmit` passed. `pnpm --dir apps/mobile exec expo run:ios --device "iPhone 17 Pro" --no-bundler` succeeded.
- Note: standalone `packages/sdk-react-native` typecheck still reports pre-existing Hugeicons declaration gaps unrelated to this fix.

## 2026-03-31 15:15 PKT
- Found one remaining root-level Hugeicons barrel import in `apps/mobile/App.tsx` (`Bug02Icon` from `@hugeicons/core-free-icons`). Switched it to direct ESM import.
- Restarted Metro on `--host lan --port 8088` and restored the IPv4 relays `8081->8088`, `8082->8089`, `8083->8090`.
- Verified the warmed bundle now responds from `http://127.0.0.1:8081/apps/mobile/index.bundle?...transform.routerRoot=app`.
- Reopened the Expo dev client with the explicit 8081 bundle URL and confirmed the Chalk home screen renders in Simulator.

## 2026-03-31 15:34 PKT
- Investigated the fresh join crash reported from the loading screen. The newest iOS crash report still showed native WebRTC camera startup on `WebRTCModule.queue`, which meant the earlier UI-only simulator guards were insufficient.
- Read the installed `@cloudflare/realtimekit-react-native` package and confirmed its local media handler eagerly sets `audioEnabled = true` and `videoEnabled = true`, then performs native `setupStreams()` during init/join.
- Found a safer seam in RealtimeKit itself: when `defaults.mediaHandler` is supplied, RTK reuses that handler instead of constructing the normal local media handler and eagerly starting capture.
- Updated `packages/sdk-react-native/src/runtime/realtimekit-loader.ts` so iOS Simulator wraps `@cloudflare/realtimekit-react-native` and forces `defaults.audio = false`, `defaults.video = false`, plus a prebuilt `initMedia({ audio: false, video: false })` handler.
- Aligned the simulator UI with that runtime behavior in `packages/sdk-react-native/src/components/NativeVideoConference.tsx`, `packages/sdk-react-native/src/components/NativePreJoinLobby.tsx`, `packages/sdk-react-native/src/components/NativeMeetingRoom.tsx`, and `packages/sdk-react-native/src/utils/ios-simulator.ts` so simulator joins start with both mic and camera off and both in-app toggles are disabled with a clear hint.
- Verification: `pnpm --dir apps/mobile exec tsc --noEmit` passed. `pnpm --dir apps/mobile exec expo run:ios --device "iPhone 17 Pro" --no-bundler` rebuilt, reinstalled, and reopened the updated iOS dev client successfully.
- Note: standalone `pnpm --dir packages/sdk-react-native exec tsc --noEmit` still fails on pre-existing Hugeicons direct-import declaration gaps and was not changed by this simulator-media fix.

## 2026-03-31 21:16 PKT
- Investigated a new simulator join crash with a different native signature. The fresh `.ips` no longer pointed at eager camera startup; it crashed inside `@cloudflare/react-native-webrtc` `receiverGetCapabilities:` on `WebRTCModule.queue`, called from the JS thread while join was still negotiating.
- Read the installed `@cloudflare/react-native-webrtc` native source and confirmed `receiverGetCapabilities` is a blocking synchronous bridge method in `WebRTCModule+Transceivers.m`, which makes simulator-only feature probing especially brittle during concurrent negotiation.
- Traced the likely caller into RealtimeKit feature detection. Its browser capability checks call `RTCRtpSender.getCapabilities("audio")` and `RTCRtpReceiver.getCapabilities("audio")` to detect support for RED audio and related behavior.
- Updated `packages/sdk-react-native/src/utils/ios-simulator.ts` to add `ensureIosSimulatorWebRtcSafety()`, which monkey-patches `RTCRtpSender.getCapabilities` and `RTCRtpReceiver.getCapabilities` to return empty RTP capabilities on iOS Simulator only.
- Updated `packages/sdk-react-native/src/runtime/realtimekit-loader.ts` to import `@cloudflare/react-native-webrtc` first on iOS Simulator, apply the capability patch before RealtimeKit initializes, and reapply it after `@cloudflare/realtimekit-react-native` registers globals.
- Verification: `pnpm --dir apps/mobile exec tsc --noEmit` passed after the simulator WebRTC safety patch.
