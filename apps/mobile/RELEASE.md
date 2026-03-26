# Chalk Mobile Release

## Local release build

Use the guarded prod-env wrapper for all local release builds. It temporarily removes `apps/mobile/.env.local`, forces prod API/WS URLs, and refuses to run without `EXPO_PUBLIC_CHALK_API_KEY`.

Important:

- local Android release bundles are for dry-runs only
- Play/TestFlight releases must use a centrally sourced host key
- Android closed/prod releases should come from `.github/workflows/mobile-android-release.yml`
- wrapper now verifies the supplied prod host key against `POST /api/v1/auth/token` before bundling

1. Generate or refresh the upload keystore
   - local file: `apps/mobile/android/app/chalk-upload-key.jks`
   - local config: `apps/mobile/android/app/keystore.properties`
   - template: `apps/mobile/android/app/keystore.properties.example`
2. Build signed bundle
   - `EXPO_PUBLIC_CHALK_API_KEY=<current-prod-key> bun run --cwd apps/mobile build:android:release:production`

Optional native refresh only when intentionally regenerating Android files:

- `bun run --cwd apps/mobile prebuild:android:production`
- do not use `--clean` for release refreshes; it wipes manual Android signing customizations

Bundle output:

- `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`
- checksum:
  - `cd apps/mobile/android/app/build/outputs/bundle/release && shasum -a 256 app-release.aab`

## Local debug APK -> phone

Fastest daily iteration path. No prod secret dependency.

1. Connect wireless adb if needed
   - `bun run mobile:connect`
   - or direct:
     - `bun run mobile:install:local -- --connect 192.168.18.140:43299`
2. Build + install debug APK
   - `bun run mobile:install:local`
3. Optional pair + connect in one shot
   - `bun run mobile:install:local -- --pair 192.168.18.140:32965 --code 665929 --connect 192.168.18.140:43299`

Notes:

- defaults to `assembleDebug`
- installs via `adb install -r -t -g`
- auto-launches `ai.q9labs.chalk.mobile`
- use CI APK workflow for prod-like multi-device builds

## Secret-backed Android CI build

Preferred when the prod host key must come from GitHub, not local env:

1. Trigger workflow:
   - APK fast lane:
     - `.github/workflows/mobile-android-release.yml`
   - AAB on-demand lane:
     - `.github/workflows/mobile-android-bundle.yml`
2. Workflow injects:
   - `EXPO_PUBLIC_API_URL=https://chalk-api.q9labs.ai`
   - `EXPO_PUBLIC_WS_URL=wss://chalk-ws.q9labs.ai/ws`
   - `EXPO_PUBLIC_CHALK_API_KEY=${{ secrets.VITE_CHALK_API_KEY }}`
3. Workflow rebuilds signing files from GitHub Secrets:
   - `ANDROID_UPLOAD_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PROPERTIES`
4. Workflow outputs:
   - APK lane:
     - `mobile-android-release-apk`
   - AAB lane:
     - `mobile-android-release-aab`
5. Use the signed APK artifact for direct device installs when Play/TestFlight review or device-side caching blocks fast validation
6. Download the produced signed AAB artifact, then upload/promote with `gplay` if the workflow itself is not publishing yet
7. Treat CI artifacts as the only uploadable Android artifacts

## Google Play service account

Google-owned step. One-time.

1. In Google Play Console:
   - create the Play app first if `ai.q9labs.chalk.mobile` does not exist yet
   - `Setup -> API access`
   - link Google Cloud project `project-for-gws-cli-1` if not linked
   - create or select service account
   - service account: `chalk-mobile-gplay@project-for-gws-cli-1.iam.gserviceaccount.com`
   - grant app access to `ai.q9labs.chalk.mobile`
   - grant release permissions needed for internal track uploads
2. Download the JSON key
3. Save it locally outside git, or inside ignored path like:
   - `apps/mobile/.gplay/service-account.json`

CLI setup:

- `cd apps/mobile`
- `gplay auth login --service-account .gplay/service-account.json --local`
- `gplay auth doctor`

Already prepared locally on this machine:

- local auth config: `apps/mobile/.gplay/config.json`
- local service-account key path: `apps/mobile/.gplay/service-account.json`
- Android upload keystore: `apps/mobile/android/app/chalk-upload-key.jks`
- Android signing props: `apps/mobile/android/app/keystore.properties`

GitHub Secrets expected for CI build/publish:

- `VITE_CHALK_API_KEY`
- `ANDROID_UPLOAD_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PROPERTIES`
- `GPLAY_SERVICE_ACCOUNT_JSON` if CI upload is enabled later

## First internal upload

From `apps/mobile`:

1. Create signed bundle
   - `bun run build:android:release`
2. Upload to internal track
   - `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --release-notes "Initial Android internal test build"`

## Post-upload verification

1. Confirm the built artifact hash
   - `cd apps/mobile/android/app/build/outputs/bundle/release && shasum -a 256 app-release.aab`
2. Confirm the uploaded bundle exists in Play
   - `edit=$(GPLAY_SERVICE_ACCOUNT_JSON=.gplay/service-account.json gplay edits create --package ai.q9labs.chalk.mobile | jq -r '.id')`
   - `GPLAY_SERVICE_ACCOUNT_JSON=.gplay/service-account.json gplay bundles list --package ai.q9labs.chalk.mobile --edit "$edit"`
3. Confirm the internal track points at the expected versionCode
   - `GPLAY_SERVICE_ACCOUNT_JSON=.gplay/service-account.json gplay tracks get --package ai.q9labs.chalk.mobile --edit "$edit" --track internal`
4. Expected good state:
   - target release `status: completed`
   - target `versionCodes` contains the newly uploaded version

Current known behavior:

- for this Play app, internal-track changes are sent for review automatically
- do **not** pass `--changes-not-sent-for-review`; Play rejects the commit with `400`
- fastest sideload lane is now `.github/workflows/mobile-android-release.yml` and downloading `mobile-android-release-apk`
- AAB/Play lane is `.github/workflows/mobile-android-bundle.yml` only when you actually need the bundle

## Optional metadata

If store listing files/screenshots exist:

- `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --listings-dir .gplay/listings --screenshots-dir .gplay/screenshots`

Tracked store-copy draft:

- `apps/mobile/PLAY_STORE_DRAFTS.md`

## Required human checks before wider rollout

- Play listing assets
- privacy policy URL
- data safety
- app content declarations
- clipboard invite suggestion:
  - Android: no new manifest permission required
  - iOS: direct pasteboard reads can trigger the system paste prompt; verify the join suggestion feels acceptable
- real device QA:
  - create meeting
  - join meeting
  - audio/video both ways
  - chat
  - transcripts
  - reconnect
  - speaker routing
  - confirm Android V1 behavior without mobile-originated screen share

## iOS / TestFlight

Current repo-backed state:

- native bundle id: `ai.q9labs.chalk.mobile`
- current V1 release contract: no mobile-originated screen share on either platform

What is already done:

- `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj` now carries:
  - `DEVELOPMENT_TEAM = 5K9635LZ6F`
  - `MARKETING_VERSION = 0.0.16`
  - `CURRENT_PROJECT_VERSION = 16`
- `apps/mobile/ios/Chalk/Info.plist` is aligned to `0.0.16 (16)`

Current blocker:

- the remaining blocker is App Store Connect upload completion against the existing app record
- previous hard failure was the auto-created app-record name collision on plain `Chalk`
- exported warning worth re-checking on next upload: `Upload Symbols Failed`

Next exact steps:

1. Open Xcode account settings
   - `open -a Xcode`
   - `Xcode -> Settings -> Accounts`
   - sign into the Apple Developer account that owns team `5K9635LZ6F`
2. Verify signing for the app target
   - open `apps/mobile/ios/Chalk.xcworkspace`
   - target `Chalk` -> `Signing & Capabilities`
   - confirm team `5K9635LZ6F`
   - confirm `Automatically manage signing` is enabled
3. Archive from CLI
   - `cd apps/mobile`
   - `EXPO_PUBLIC_CHALK_API_KEY=<current-prod-key> bun run ./scripts/run-with-production-mobile-env.ts -- xcodebuild -workspace ios/Chalk.xcworkspace -scheme Chalk -configuration Release -sdk iphoneos -archivePath ios/build/Chalk-0.0.16.xcarchive archive -allowProvisioningUpdates`
4. Export/upload to TestFlight
   - `cd apps/mobile`
   - `EXPO_PUBLIC_CHALK_API_KEY=<current-prod-key> bun run ./scripts/run-with-production-mobile-env.ts -- xcodebuild -exportArchive -archivePath ios/build/Chalk-0.0.16.xcarchive -exportPath /Users/macmini/Desktop/Code/chalk/scratchpad/upload-logs/fresh-0.0.16 -exportOptionsPlist /Users/macmini/Desktop/Code/chalk/scratchpad/upload-logs/ExportOptions.plist -allowProvisioningUpdates`

Human checks before wider rollout:

- verify the Apple paste prompt UX for clipboard invite suggestion
- verify camera + mic prompts
- verify background audio
- verify create/join on a real iPhone
- verify receive-only remote screen-share behavior is acceptable for V1
