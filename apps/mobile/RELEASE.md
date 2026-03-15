# Chalk Mobile Release Checklist

## Android

- Create `apps/mobile/android/app/keystore.properties` from `keystore.properties.example`
- Add upload keystore `.jks` file locally or via CI secret mount
- Confirm release build uses upload key, not debug signing
- Keep cleartext traffic debug-only
- Verify only required permissions remain in the final merged manifest
- Set Play Store listing assets
- Set privacy policy URL
- Complete Play Console data safety + app content
- Run device QA:
  - create meeting
  - join meeting
  - 2-way audio/video
  - chat
  - transcripts
  - leave/end
  - reconnect
  - background/foreground
  - speaker routing
  - screen share

### Build

- Local release bundle: `bun run build:android:release`
- Production prebuild sync: `bun run prebuild:android:production`

## iOS

- Native project now exists under `apps/mobile/ios`
- Set Apple team / signing in Xcode or EAS credentials
- Verify `NSCameraUsageDescription` + `NSMicrophoneUsageDescription`
- Add ReplayKit broadcast extension if shipping mobile-originated screen share
- Set App Store Connect listing assets + privacy policy
- Run device QA on at least two real iPhones if possible
- Ship internal TestFlight first

### Build

- Production prebuild sync: `bun run prebuild:ios:production`
- Open in Xcode for signing + archive: `open ios/Chalk.xcodeproj`

## Known External Blockers

- Android upload keystore secrets are not in the repo
- Apple signing team / certificates are not in the repo
- Store metadata, privacy policy URL, and listing assets still require human/account setup
- Final publish confidence still needs multi-device QA, not just one phone
