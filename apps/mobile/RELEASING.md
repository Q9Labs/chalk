# Releasing the mobile app

Release builds are signed by `apps/mobile/scripts/release/build-signed-ios.sh` and `apps/mobile/scripts/release/build-signed-android.sh`. The workflow `.github/workflows/mobile-signed-build.yml` runs both on master; a Mac runs the iOS script the same way:

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @q9labsai/chalk-mobile run prepare:native-dependencies`
3. `pod install --project-directory=ios` from `apps/mobile`
4. `apps/mobile/scripts/release/build-signed-ios.sh`, with `op` signed in to the release vault

Three version numbers must agree before a build: `version` and the iOS `buildNumber` and Android `versionCode` in `app.config.ts`, the matching values in `ios/Chalk.xcodeproj/project.pbxproj` and `ios/Chalk/Info.plist`, and `chalk.versionCode` and `chalk.versionName` in `android/gradle.properties`.

Xcode 27 refuses Pods whose deployment target is below its supported range. The Podfile `post_install` hook raises every Pod to the app's minimum (15.1), so the archive builds on Xcode 26 and 27 without extra flags.

The release notes for each mobile tag name the Xcode, macOS, Node, pnpm, Gradle and JDK versions used.
