# Releasing the mobile app

Release builds are signed by `apps/mobile/scripts/release/build-signed-ios.sh` and `apps/mobile/scripts/release/build-signed-android.sh`. The workflow `.github/workflows/mobile-signed-build.yml` runs both on master; a Mac runs the iOS script the same way:

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @q9labsai/chalk-mobile run prepare:native-dependencies`
3. `pod install --project-directory=ios` from `apps/mobile`
4. `apps/mobile/scripts/release/build-signed-ios.sh`, with `op` signed in to the release vault

The version lives in several files, and `node apps/mobile/scripts/check-version-surfaces.mjs` (part of the mobile `test` script) fails when they disagree. The version name appears in `apps/mobile/app.config.ts`, `apps/mobile/android/gradle.properties`, the `apps/mobile/android/app/build.gradle` fallback, `release/manifest.json`, `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj` and `apps/mobile/ios/Chalk/Info.plist`. The Android version code appears in the first four of those, and the iOS build number in `app.config.ts`, `project.pbxproj` and `Info.plist`. The signed Android build reads its code from `release/manifest.json`.

Pick the Android version code with `apps/mobile/scripts/release/next-play-version-code.sh`, never by hand. It prints one above every bundle and APK on Play, and the nightly publisher takes its code from the same script, so a store release and a nightly build cannot collide. Play also keeps codes from uploads it no longer lists, and rejects them as already used.

Xcode 27 refuses Pods whose deployment target is below its supported range. The Podfile `post_install` hook raises every Pod to the app's minimum (15.1), so the archive builds on Xcode 26 and 27 without extra flags.

The release notes for each mobile tag name the Xcode, macOS, Node, pnpm, Gradle and JDK versions used.
