# Chalk Mobile Release

## Local release build

1. Generate or refresh the upload keystore
   - local file: `apps/mobile/android/app/chalk-upload-key.jks`
   - local config: `apps/mobile/android/app/keystore.properties`
   - template: `apps/mobile/android/app/keystore.properties.example`
2. Build signed bundle
   - `bun run --cwd apps/mobile build:android:release`

Optional native refresh only when intentionally regenerating Android files:

- `bun run --cwd apps/mobile prebuild:android:production`
- do not use `--clean` for release refreshes; it wipes manual Android signing customizations

Bundle output:

- `apps/mobile/android/app/build/outputs/bundle/release/app-release.aab`
- checksum:
  - `cd apps/mobile/android/app/build/outputs/bundle/release && shasum -a 256 app-release.aab`

## Secret-backed Android CI build

Preferred when the prod host key must come from GitHub, not local env:

1. Trigger workflow:
   - `.github/workflows/mobile-android-release.yml`
2. Workflow injects:
   - `EXPO_PUBLIC_API_URL=https://chalk-api.q9labs.ai`
   - `EXPO_PUBLIC_WS_URL=wss://chalk-ws.q9labs.ai/ws`
   - `EXPO_PUBLIC_CHALK_API_KEY=${{ secrets.VITE_CHALK_API_KEY }}`
3. Workflow rebuilds signing files from GitHub Secrets:
   - `ANDROID_UPLOAD_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PROPERTIES`
4. Download the produced signed AAB artifact, then upload/promote with `gplay` if the workflow itself is not publishing yet

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

## Optional metadata

If store listing files/screenshots exist:

- `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --listings-dir .gplay/listings --screenshots-dir .gplay/screenshots`

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

- EAS project: `@hhushhas14/chalk-mobile`
- EAS project id: `699bd2b8-fe9b-4740-9de4-b23741ce9d6b`
- native bundle id: `ai.q9labs.chalk.mobile`
- current V1 release contract: no mobile-originated iOS screen share

What is already done:

- `apps/mobile/app.config.ts` now pins the EAS owner + project id
- `apps/mobile/ios/Chalk.xcodeproj/project.pbxproj` now carries:
  - `DEVELOPMENT_TEAM = 4V7RXZU8P2`
  - `MARKETING_VERSION = 0.0.10`
  - `CURRENT_PROJECT_VERSION = 10`
- `apps/mobile/ios/Chalk/Info.plist` is aligned to `0.0.10 (10)`

Current blocker:

- non-interactive EAS build reaches remote iOS credentials, then stops with:
  - `Failed to set up credentials. Credentials are not set up. Run this command again in interactive mode.`
- local Xcode archive also gets past project config and then fails on Apple-account provisioning state

Next exact steps:

1. Configure iOS build credentials interactively
   - `cd apps/mobile`
   - `eas credentials -p ios`
   - log into the Apple Developer account when prompted
   - let EAS create/validate the missing distribution certificate + provisioning profile
2. Run the production build
   - `cd apps/mobile`
   - `eas build --platform ios --profile production`
3. Submit to TestFlight
   - `cd apps/mobile`
   - `eas submit --platform ios --profile production --latest`

Human checks before wider rollout:

- verify the Apple paste prompt UX for clipboard invite suggestion
- verify camera + mic prompts
- verify background audio
- verify create/join on a real iPhone
- verify receive-only remote screen-share behavior is acceptable for V1
