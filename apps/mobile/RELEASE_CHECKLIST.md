# Chalk Mobile Release Checklist

## Android

- create Play Console app `ai.q9labs.chalk.mobile` if it does not exist yet
- link Google Cloud project `project-for-gws-cli-1` under `Setup -> API access`
- grant `chalk-mobile-gplay@project-for-gws-cli-1.iam.gserviceaccount.com` access to the app
- create upload keystore from `android/app/keystore.properties.example`
- add real `keystore.properties` locally
- or provide `ANDROID_UPLOAD_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PROPERTIES` in GitHub Secrets for CI builds
- run local prod builds only through `scripts/run-with-production-mobile-env.ts`
- confirm `bundleRelease` succeeds
- confirm `assembleRelease` succeeds when a sideload APK is needed
- record the shipped AAB sha256 from `android/app/build/outputs/bundle/release/app-release.aab`
- record the sideload APK sha256 from `android/app/build/outputs/apk/release/app-release.apk` when generated
- verify Play bundle library contains the uploaded versionCode
- verify the `internal` track points at the intended versionCode after upload
- confirm release build host key comes from `VITE_CHALK_API_KEY` secret, not local `.env.local`
- confirm `bun run --cwd apps/mobile verify:production-host-key` passes before any uploadable build
- prefer workflow `.github/workflows/mobile-android-release.yml` for device-installable prod APK builds
- use workflow `.github/workflows/mobile-android-bundle.yml` only when an AAB/Play upload is needed
- verify `SYSTEM_ALERT_WINDOW` is not required before release
- verify Android V1 release is acceptable without mobile-originated screen share
- confirm production build has no cleartext HTTP dependency
- verify clipboard invite suggestion feels correct
  - Android: no new manifest permission required
  - iOS: direct pasteboard reads may show the Apple paste prompt
- update Play listing assets, privacy policy, data safety, reviewer notes

## iOS

- open `ios/Chalk.xcworkspace` in Xcode
- set Apple team + signing for `ai.q9labs.chalk.mobile`
- run local archive/upload only through `scripts/run-with-production-mobile-env.ts`
- archive a release build on a real signing identity
- verify camera + mic permission prompts copy
- verify background audio behavior
- verify iOS V1 is acceptable without mobile-originated screen share
- if iOS mobile-originated screen share is needed later, add ReplayKit broadcast upload extension + app groups
- prepare App Store screenshots, privacy policy, reviewer notes

## Product QA

- create meeting on mobile
- join meeting from mobile
- mobile + web two-way audio/video
- mobile + emulator or second device join/leave/rejoin
- chat send/receive
- transcript visibility
- mute / video toggle
- leave / end-for-all
- reconnect after network interruption
- speaker / earpiece / Bluetooth routing

## Release Gate

- `bun run --cwd apps/mobile check-types`
- `bun run --cwd apps/mobile test`
- `bun run --cwd packages/sdk-react-native check-types`
- Android release bundle builds
- iOS archive builds
