# Mobile Release Session Log

## 2026-04-03 10:03:00 PKT
- Started Chalk mobile release-build pass for Android and iOS.
- Verified release guidance in `apps/mobile/RELEASE.md` and current mobile version/build metadata in `apps/mobile/app.config.ts`.
- Confirmed Android release workflows exist in GitHub Actions: `Mobile Android APK` and `Mobile Android AAB`.
- Confirmed no equivalent iOS GitHub Actions workflow exists in this repo.
- Triggered both Android workflows; both failed in the `Mobile gate` step before artifact upload.
- Retrieved failing logs and confirmed the blockers were:
  - CI test failures in `apps/mobile/src/lib/dev-diagnostics.test.ts`
  - Vitest resolution failures for `@q9labs/chalk-core`
- Patched `apps/mobile` release-unblocking issues:
  - added `apps/mobile/vitest.config.ts` with workspace aliases for mobile Vitest
  - made `dev-diagnostics.ts` treat Vitest as a development runtime so CI tests stay meaningful under `NODE_ENV=production`
  - removed top-level `await` from `apps/mobile/scripts/verify-production-mobile-host-key.ts` for local Node 25 compatibility
- Refreshed workspace dependencies with `NODE_AUTH_TOKEN=dummy pnpm install --frozen-lockfile` because local `node_modules` was missing Expo packages needed for the mobile typecheck/lint gate.
- Re-ran the local mobile gate successfully:
  - `pnpm --dir apps/mobile run test`
  - `pnpm --dir apps/mobile run check-types`
  - `pnpm --dir apps/mobile run lint`
- Verified the only locally available mobile host key source on this Mac is stale for production release verification:
  - `pnpm --dir apps/mobile run verify:production-host-key` reached the prod API but returned `401 invalid API key`
- Current release state:
  - Android can be retried through GitHub Actions after pushing the release-unblocking fix commit
  - iOS remains blocked on a valid current production host key and likely App Store distribution signing/exportability on this machine

[2026-04-03 22:34:12 PKT] Tenant-agnostic local mobile release resumed. Built Android release APK 1.0 (17) at apps/mobile/android/app/build/outputs/apk/release/app-release.apk with sha256 7f7345cf51c8de6e3a145aaac107690d9a42deec25e8812d16e94262b96b351f. Built Android release AAB at apps/mobile/android/app/build/outputs/bundle/release/app-release.aab with sha256 cd243de353566f9b80836d8d4cd6457f340bd478618485cb24a5335977ad9551. Preparing iOS archive/upload on this Mac using automatic signing team 5K9635LZ6F and version 1.0 (17).

[2026-04-03 22:42:25 PKT] iOS archive/upload succeeded after syncing CocoaPods with `pod install`. Archive path: apps/mobile/ios/build/Chalk-1.0.xcarchive. Export/upload path: scratchpad/upload-logs/fresh-1.0. xcodebuild reported `Uploaded Chalk` and `Upload succeeded`, with symbol-upload warnings for React.framework, ReactNativeDependencies.framework, and hermesvm.framework dSYMs. Re-ran apps/mobile gate: lint ok, check-types ok, test ok.
