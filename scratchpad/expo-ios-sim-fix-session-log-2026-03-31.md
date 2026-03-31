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
