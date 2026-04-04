
[2026-04-03 08:46:46 PKT] Investigating iOS runtime env mismatch from diagnostics JSON (prod apiUrl/wsUrl on local dev client); checking Expo env resolution and iPad black-screen side effects.
[2026-04-03 08:47:23 PKT] Root cause identified: resolveDeviceLocalUrl() falls back from configured localhost API/WS to prod fallback when Metro scriptUrl host is also localhost. This breaks simulator/dev-client local runs and surfaces invalid prod host-key errors.
[2026-04-03 08:47:47 PKT] Patched mobile-runtime localhost resolution for simulator/dev-client localhost bundles and added regression coverage in mobile-runtime.test.ts.

[2026-04-03 08:55:09 PKT] User reported iPad simulator black/unresponsive after launch and lingering Hasan Headquaters system-name prompts. Reopening iPad, diagnosing runtime, and removing old native app name references.
[2026-04-03 08:55:34 PKT] Renamed remaining user-facing Hasan Headquaters strings to Chalk in app config, iOS Info.plist, Android strings, HQ screen title, and dictation microphone alert.
[2026-04-03 08:56:22 PKT] iPad relaunch succeeded; black/unresponsive report traced to app foregrounding into paste-permission prompt. Rebuilding iOS app so native display name changes from Hasan Headquaters to Chalk.
[2026-04-03 08:58:57 PKT] Removed stale simulator device named Hasan Headquaters Fresh to eliminate leftover old-name surface area.
[2026-04-03 08:59:42 PKT] Creating dedicated iPhone 11 Pro Max simulator for App Store Connect 6.5-inch screenshots.
[2026-04-03 09:05:39 PKT] Verifying App Store screenshot artifact dimensions after ASC rejected upload as wrong size.

[2026-04-03 09:15:52 PKT] Generating clean 6.5-inch App Store screenshot set: home, lobby, room, chat, more-sheet.
[2026-04-03 09:20:47 PKT] Installing local Pillow utility to clean App Store screenshot exports without altering repo dependencies.
[2026-04-03 09:20:55 PKT] Switched screenshot cleanup to isolated scratchpad venv after system Python rejected direct install.

[2026-04-03 09:54:28 PKT] Preparing scoped commit/push for iOS simulator runtime fix and mobile app-name cleanup. Running gates before commit.
