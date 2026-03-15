# Chalk Mobile Android Release

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

## First internal upload

From `apps/mobile`:

1. Create signed bundle
   - `bun run build:android:release`
2. Upload to internal track
   - `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --release-notes "Initial Android internal test build" --changes-not-sent-for-review`

## Optional metadata

If store listing files/screenshots exist:

- `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --listings-dir .gplay/listings --screenshots-dir .gplay/screenshots`

## Required human checks before wider rollout

- Play listing assets
- privacy policy URL
- data safety
- app content declarations
- real device QA:
  - create meeting
  - join meeting
  - audio/video both ways
  - chat
  - transcripts
  - reconnect
  - speaker routing
  - screen share
