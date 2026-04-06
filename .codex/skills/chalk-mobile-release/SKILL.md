---
name: chalk-mobile-release
description: Release Chalk mobile builds to Google Play and iOS/TestFlight. Use when building or publishing `apps/mobile`, bumping mobile versions, uploading Android bundles to Play, navigating Play Console with Helium + agent-browser, handling internal testing, or troubleshooting common mobile release blockers.
---

# Chalk Mobile Release

Use this for Chalk mobile release work only.

This file is the single source of truth for Chalk mobile release work.
Do not create or maintain parallel release docs under `apps/mobile/` for the same flow.
If a real release attempt reveals anything inaccurate here, update this skill before closing the task.

Companion skills/tools:
- `gplay-cli-usage` for CLI flags/patterns
- `asc` for iOS App Store Connect / TestFlight upload, distribution, validation, and submission steps after local archive/export
- global `agent-browser-helium` when Hasan wants Helium/CDP browser automation

Primary files:
- `apps/mobile/app.config.ts`
- `apps/mobile/android/gradle.properties`
- `apps/mobile/android/app/build.gradle`
- `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj`
- `apps/mobile/ios/Chalk/Info.plist`
- `apps/mobile/ios/Podfile.lock`
- `apps/mobile/scripts/run-with-production-mobile-env.ts`
- `apps/mobile/scripts/verify-production-mobile-host-key.ts`
- `apps/mobile/src/lib/chalk.ts`
- `apps/mobile/src/lib/mobile-runtime.ts`
- `scratchpad/upload-logs/ExportOptions.plist`

## Defaults

- Android first
- internal track first
- preserve existing Play/Helium session
- prefer CLI for repeatable state; use Play Console UI when Play API gets flaky
- on future iOS release runs, explicitly consider `asc` anywhere it helps complete App Store Connect / TestFlight work before handing off to Hasan

## Current Release Truths

- Current release baseline is `1.0 (17)` unless the repo has been bumped since this was last updated.
- Version alignment lives in:
  - `apps/mobile/app.config.ts`
  - `apps/mobile/android/gradle.properties`
  - `apps/mobile/android/app/build.gradle`
  - `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj`
  - `apps/mobile/ios/Chalk/Info.plist`
- Chalk mobile release builds are now tenant-agnostic.
- Do not assume `EXPO_PUBLIC_CHALK_API_KEY` is required for release builds.
- The guarded production wrapper still forces:
  - `https://chalk-api.q9labs.ai`
  - `wss://chalk-ws.q9labs.ai/ws`
- The wrapper temporarily removes `apps/mobile/.env.local` during release commands so local dev values do not leak into store builds.
- If no host API key is present, `apps/mobile/scripts/verify-production-mobile-host-key.ts` now skips verification instead of blocking the build.
- Local signed Android artifacts built on this Mac are valid release artifacts.
- Local iOS archive and TestFlight upload from this Mac are also valid when Xcode signing is working.
- Do not assume GitHub Actions is the preferred or only release lane.
- App Store Connect upload succeeded locally via `xcodebuild -exportArchive` using:
  - automatic signing
  - team `5K9635LZ6F`
  - `scratchpad/upload-logs/ExportOptions.plist`
- Current known iOS warning from successful upload:
  - symbol upload warnings for `React.framework`, `ReactNativeDependencies.framework`, and `hermesvm.framework`
- If `xcodebuild archive` fails with `[CP] Check Pods Manifest.lock`, run `cd apps/mobile/ios && pod install` and retry.

## Android release flow

1. Verify versioning
   - `apps/mobile/app.config.ts`
   - `apps/mobile/android/gradle.properties`
   - `apps/mobile/android/app/build.gradle`
   - keep `version`, `buildNumber`, `versionCode`, `chalk.versionCode`, `chalk.versionName` aligned
2. Run mobile gate
   - `cd apps/mobile && pnpm run lint`
   - `cd apps/mobile && pnpm run check-types`
   - `cd apps/mobile && pnpm run test`
   - when RN package changed too:
     - `cd packages/sdk-react-native && pnpm run lint`
     - `cd packages/sdk-react-native && pnpm run check-types`
     - `cd packages/sdk-react-native && pnpm run test`
3. Build signed APK if you want a direct installer artifact
   - `cd apps/mobile && pnpm run build:android:apk:release:production`
4. Build signed AAB for Play upload
   - `cd apps/mobile && pnpm run build:android:release:production`
5. Record artifact paths and checksums
   - APK:
     - `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
     - `cd apps/mobile/android/app/build/outputs/apk/release && shasum -a 256 app-release.apk`
   - AAB:
     - `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`
     - `cd apps/mobile/android/app/build/outputs/bundle/release && shasum -a 256 app-release.aab`
6. Preferred upload when Play CLI is healthy
   - `cd apps/mobile`
   - `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --release-notes "..."`
7. If `gplay` is flaky, inspect/patch track state manually
   - `gplay edits create`
   - `gplay bundles list`
   - `gplay tracks get --track internal`
   - `gplay tracks update`
   - `gplay edits commit`
8. If Play API still fights, use Play Console UI in Helium

### Chalk production env rule

Never trust `apps/mobile/.env.local` for release.

For Chalk:
- local dev may point `EXPO_PUBLIC_API_URL` / `EXPO_PUBLIC_WS_URL` at `localhost`
- production builds must force:
  - `https://chalk-api.q9labs.ai`
  - `wss://chalk-ws.q9labs.ai/ws`

Verify both:
- `apps/mobile/app.config.ts`
- `apps/mobile/src/lib/chalk.ts`
- `apps/mobile/src/lib/mobile-runtime.ts`
- `apps/mobile/scripts/run-with-production-mobile-env.ts`

If a tester reports `New Meeting -> Network Error`, suspect release env leakage first.

## Helium / Play Console workflow

Use the global `agent-browser-helium` skill.

Proven flow:
1. attach to Helium CDP on `9222`
2. open Play Console app list first, not deep links
3. open Chalk app from list
4. expand `Test and release`
5. use `Internal testing`
6. inspect:
   - current completed release
   - draft release
   - bundle library

Why:
- Play deep links often bounce to app list
- refs go stale fast; resnapshot constantly
- if file upload via remote browser automation is flaky/size-limited, prefer `gplay` CLI for bundle upload and use browser only for Play policy/forms/review buttons

## Proven Play troubleshooting

### `This edit has expired, please create a new Edit`

Meaning:
- Play edit expired during upload/update

Try:
1. create a fresh edit
2. check whether the bundle already uploaded anyway:
   - `gplay bundles list --package ai.q9labs.chalk.mobile --edit <id>`
3. if uploaded, skip re-upload and only update/commit the track
4. if `gplay` keeps expiring, switch to Play Console UI

### `A change was made to the application outside of this Edit`

Meaning:
- app state changed while the edit was open

Fix:
- fresh edit
- re-read current track
- update with current versionCodes only

### `Only releases with status draft may be created on draft app`

Meaning:
- overall Play app state is still draft / pending review

Fix:
- create/commit internal release as `draft`
- then finish the remaining Play Console `Send for review` / `Publish changes` click path manually

### Internal track shows old build

Check both:
- bundle library contains the new `versionCode`
- internal track points to the new `versionCode`

Do not assume upload == rollout.

Fast recovery:
1. create fresh edit
2. point `internal` track directly at the already-approved `versionCode`
3. commit the edit

Pattern:
```bash
GPLAY_SERVICE_ACCOUNT_JSON=apps/mobile/.gplay/service-account.json \
gplay edits create --package ai.q9labs.chalk.mobile

GPLAY_SERVICE_ACCOUNT_JSON=apps/mobile/.gplay/service-account.json \
gplay tracks update --package ai.q9labs.chalk.mobile --edit <id> --track internal --releases '[{"name":"0.0.x-internal","status":"completed","versionCodes":["<versionCode>"],"releaseNotes":[{"language":"en-US","text":"..."}]}]'

GPLAY_SERVICE_ACCOUNT_JSON=apps/mobile/.gplay/service-account.json \
gplay edits commit --package ai.q9labs.chalk.mobile --edit <id>
```

This is valid when the same artifact already passed review on another track like `alpha`.

### Network issue in installed release build

For Chalk, first check:
- `EXPO_PUBLIC_API_URL`
- `EXPO_PUBLIC_WS_URL`
- localhost fallback behavior in `apps/mobile/src/lib/chalk.ts` and `apps/mobile/src/lib/mobile-runtime.ts`

Important:
- React Native native networking usually is not blocked by browser CORS
- if Play/TestFlight build points at `localhost`, it means the phone itself
- if the app on-device still fails after Play says the new build is completed, verify the installed version and consider sideloading the signed release APK for immediate proof

## Common Chalk-specific release truths

- `apps/mobile/.env.local` may be safe for dev but dangerous for release if it points at `localhost`
- local dev works because Metro host rewrite exists; release builds have no Metro `scriptURL`
- Chalk now hard-blocks device-local API/WS URLs in production builds; keep that behavior
- Play can accept the bundle upload but still leave internal release as draft
- `gplay` local install may be a dev build; if behavior looks wrong, verify with `gplay version`
- direct APK fallback used in practice: build `app-release.apk`, then upload to a temporary host only when testers are blocked by Play review/caching
- for this Play app, `--changes-not-sent-for-review` should not be passed when Play is auto-sending changes for review; it can fail with `400`

## iOS lane

Use when asked, but Android remains the default critical path.

Checklist:
- verify `buildNumber` bump
- verify signing/team in Xcode
- run `pod install` if CocoaPods drift appears
- archive build
- upload to TestFlight
- validate camera/mic/background-audio behavior

If iOS screen share is in scope:
- ReplayKit broadcast extension
- app groups
- explicit QA before release

## iOS / TestFlight Flow

Current repo-backed state:

- native bundle id: `ai.q9labs.chalk.mobile`
- current V1 release contract: no mobile-originated screen share on either platform
- Xcode archive on this Mac succeeded with automatic signing
- successful local upload used the export options at `scratchpad/upload-logs/ExportOptions.plist`

Exact working flow:

1. Verify release metadata is aligned
   - `apps/mobile/app.config.ts`
   - `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj`
   - `apps/mobile/ios/Chalk/Info.plist`
2. Verify signing in Xcode if needed
   - open `apps/mobile/ios/Chalk.xcworkspace`
   - target `Chalk` -> `Signing & Capabilities`
   - confirm team `5K9635LZ6F`
   - confirm `Automatically manage signing` is enabled
3. If archive fails with CocoaPods sync errors
   - `cd apps/mobile/ios && pod install`
4. Archive from CLI
   - `cd apps/mobile && pnpm run with:production-release-env -- xcodebuild -workspace ios/Chalk.xcworkspace -scheme Chalk -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' -archivePath ios/build/Chalk-<version>.xcarchive archive -allowProvisioningUpdates`
5. Export and upload to TestFlight
   - `cd apps/mobile && pnpm run with:production-release-env -- xcodebuild -exportArchive -archivePath ios/build/Chalk-<version>.xcarchive -exportPath /Users/macmini/Desktop/Code/chalk/scratchpad/upload-logs/fresh-<version> -exportOptionsPlist /Users/macmini/Desktop/Code/chalk/scratchpad/upload-logs/ExportOptions.plist -allowProvisioningUpdates`
6. Watch for final success markers
   - `Uploaded Chalk`
   - `Upload succeeded`
   - `EXPORT SUCCEEDED`
7. Treat dSYM upload warnings as follow-up work, not necessarily a release blocker, unless App Store Connect rejects processing

Current known successful example:

- archive path:
  - `apps/mobile/ios/build/Chalk-1.0.xcarchive`
- export path:
  - `scratchpad/upload-logs/fresh-1.0`

## Release handoff

Report:
- version/build numbers
- gate results
- built artifact path + sha256
- Play/TestFlight state
- internal testing install path
- direct APK fallback path, if created
- exact remaining human clicks, if any

Never say “released” unless:
- artifact built
- store accepted it
- target track/test channel points at the new version

## Human Checks Before Wider Rollout

- Play listing assets
- App Store screenshots
- privacy policy URL
- Play data safety
- App Store App Privacy answers
- app content declarations
- App Store pricing
- App Store content rights
- App Review notes and contact details
- clipboard invite suggestion:
  - Android: no new manifest permission required
  - iOS: direct pasteboard reads may show the Apple paste prompt
- real device QA:
  - create meeting
  - join meeting
  - audio/video both ways
  - chat
  - transcripts
  - reconnect
  - speaker routing
  - camera + mic permission prompts
  - background audio
  - verify Android and iOS V1 behavior without mobile-originated screen share

## Maintenance Rule

After every real release attempt:

1. Reconcile this skill with what actually happened.
2. Update commands, blockers, version assumptions, signing notes, and store behavior if reality differed.
3. Remove stale instructions instead of layering contradictory notes on top.
4. If the release required improvisation not covered here, encode that learning here before closing the task.
5. Treat doc reconciliation as part of the release task, not optional follow-up.
