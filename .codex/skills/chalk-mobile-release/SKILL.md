---
name: chalk-mobile-release
description: Release Chalk mobile builds to Google Play and iOS/TestFlight. Use when building or publishing `apps/mobile`, bumping mobile versions, uploading Android bundles to Play, navigating Play Console with Helium + agent-browser, handling internal testing, or troubleshooting common mobile release blockers.
---

# Chalk Mobile Release

Use this for Chalk mobile release work only.

Companion skills/tools:
- `gplay-cli-usage` for CLI flags/patterns
- global `agent-browser-helium` when Hasan wants Helium/CDP browser automation

Primary files:
- `apps/mobile/RELEASE.md`
- `apps/mobile/RELEASE_CHECKLIST.md`
- `apps/mobile/app.config.ts`
- `apps/mobile/android/gradle.properties`
- `apps/mobile/android/app/build.gradle`
- `apps/mobile/src/lib/chalk.ts`
- `apps/mobile/src/lib/mobile-runtime.ts`

## Defaults

- Android first
- internal track first
- preserve existing Play/Helium session
- prefer CLI for repeatable state; use Play Console UI when Play API gets flaky

## Android release flow

1. Verify versioning
   - `apps/mobile/app.config.ts`
   - `apps/mobile/android/gradle.properties`
   - keep `version`, `buildNumber`, `versionCode`, `chalk.versionCode`, `chalk.versionName` aligned
2. Run mobile gate
   - `bun run --cwd apps/mobile lint`
   - `bun run --cwd apps/mobile check-types`
   - `bun run --cwd apps/mobile test`
   - when RN package changed too:
     - `bun run --cwd packages/sdk-react-native lint`
     - `bun run --cwd packages/sdk-react-native check-types`
     - `bun run --cwd packages/sdk-react-native test`
3. Build signed AAB
   - `bun run --cwd apps/mobile build:android:release`
   - if you need a direct sideload fallback too:
     - `cd apps/mobile/android && ./gradlew assembleRelease`
4. Preferred upload
   - `cd apps/mobile`
   - `gplay release --package ai.q9labs.chalk.mobile --track internal --bundle android/app/build/outputs/bundle/release/app-release.aab --release-notes "..." --changes-not-sent-for-review`
5. If `gplay` is flaky, inspect/patch track state manually
   - `gplay edits create`
   - `gplay bundles list`
   - `gplay tracks get --track internal`
   - `gplay tracks update`
   - `gplay edits commit`
6. If Play API still fights, use Play Console UI in Helium

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

## iOS lane

Use when asked, but Android remains the default critical path.

Checklist:
- verify `buildNumber` bump
- verify signing/team in Xcode
- archive build
- upload to TestFlight
- validate camera/mic/background-audio behavior

If iOS screen share is in scope:
- ReplayKit broadcast extension
- app groups
- explicit QA before release

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
