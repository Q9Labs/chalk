# Releasing the mobile app

Release builds are signed by `apps/mobile/scripts/release/build-signed-ios.sh` and `apps/mobile/scripts/release/build-signed-android.sh`. The workflow `.github/workflows/mobile-signed-build.yml` runs both on master; a Mac runs the iOS script the same way:

1. `pnpm install --frozen-lockfile`
2. `pnpm --filter @q9labsai/chalk-mobile run prepare:native-dependencies`
3. `pod install --project-directory=ios` from `apps/mobile`
4. `apps/mobile/scripts/release/build-signed-ios.sh`, with `op` signed in to the release vault

`release/manifest.json` holds the version name, the Android version code, the iOS build number and the bundle ids. `app.config.ts` and `android/app/build.gradle` read it directly. Xcode needs literal values, so `pnpm run regen` writes them into `ios/Chalk.xcodeproj/project.pbxproj`, `ios/Chalk/Info.plist` and `package.json`, and `pnpm run check:generated` fails when they are stale. Change the manifest, then run `pnpm run regen`.

Pick the Android version code with `apps/mobile/scripts/release/next-play-version-code.sh`, never by hand. It prints one above every bundle and APK on Play, and the nightly publisher takes its code from the same script, so a store release and a nightly build cannot collide. Play also keeps codes from uploads it no longer lists, and rejects them as already used.

After each passing "Cut nightly", `.github/workflows/mobile-nightly-ios.yml` uploads an iOS build to TestFlight, where the internal "Testers" group sees it. It skips the cut when nothing under `apps/mobile`, `packages`, the lockfile or the release manifest changed since the last nightly upload. The build number is the next free one from App Store Connect (`asc builds next-build-number`), passed to the signed build as `CHALK_IOS_BUILD_NUMBER`, so nightly builds and store releases cannot collide. Each upload carries `Nightly <sha>` as its TestFlight notes, and the next run reads that to find the last uploaded revision. The App Store Connect API key comes from the release vault through the same 1Password service account as the signing files (its item id is the `ASC_CREDENTIAL_ITEM_ID` variable of the `production-signing` environment, kept out of Git).

Xcode 27 refuses Pods whose deployment target is below its supported range. The Podfile `post_install` hook raises every Pod to the app's minimum (15.1), so the archive builds on Xcode 26 and 27 without extra flags.

The release notes for each mobile tag name the Xcode, macOS, Node, pnpm, Gradle and JDK versions used.
