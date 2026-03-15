# Chalk Mobile Release Checklist

## Android

- create Play Console app `ai.q9labs.chalk.mobile` if it does not exist yet
- link Google Cloud project `project-for-gws-cli-1` under `Setup -> API access`
- grant `chalk-mobile-gplay@project-for-gws-cli-1.iam.gserviceaccount.com` access to the app
- create upload keystore from `android/app/keystore.properties.example`
- add real `keystore.properties` locally
- or provide `ANDROID_UPLOAD_KEYSTORE_BASE64` + `ANDROID_KEYSTORE_PROPERTIES` in GitHub Secrets for CI builds
- confirm `bundleRelease` succeeds
- confirm release build host key comes from `VITE_CHALK_API_KEY` secret, not local `.env.local`
- verify `SYSTEM_ALERT_WINDOW` is not required before release
- verify screen share still works with current foreground-service permissions
- confirm production build has no cleartext HTTP dependency
- update Play listing assets, privacy policy, data safety, reviewer notes

## iOS

- open `ios/Chalk.xcodeproj` in Xcode
- set Apple team + signing for `ai.q9labs.chalk.mobile`
- archive a release build on a real signing identity
- verify camera + mic permission prompts copy
- verify background audio behavior
- decide whether V1 includes iOS screen share
- if yes, add ReplayKit broadcast upload extension + app groups
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
