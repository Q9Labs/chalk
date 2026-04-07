2026-04-07 10:29:12 PKT | Starting platform UI split simulator pass for Android, iPhone, and iPad targets
2026-04-07 10:29:12 PKT | Confirmed mobile workspace commands, local simulator availability, and iOS simulator automation tooling
2026-04-07 10:30:50 PKT | Booted iPhone 17 Pro and iPad Pro 13-inch (M5); started Chalk-Pixel-9 Android emulator and confirmed adb connection as emulator-5554
2026-04-07 10:36:27 PKT | Reused installed Chalk dev clients, started bridged Metro via apps/mobile start:ios-sim, and opened Android plus iPhone onto the Chalk home screen
2026-04-07 10:36:27 PKT | iPad launch repeatedly returned to home screen; captured fresh crash reports in ~/Library/Logs/DiagnosticReports/Chalk-2026-04-07-103543.ips and Chalk-2026-04-07-103338.ips showing EXC_BAD_ACCESS / SIGSEGV during simulator run
2026-04-07 11:06:03 PKT | Disabled EX_DEV_CLIENT_NETWORK_INSPECTOR for iOS native debug builds, added a simulator clipboard-read guard, and verified the mobile runtime test file still passes
2026-04-07 11:06:03 PKT | After a clean Metro/dev-client restart, iPad and iPhone both relaunched into Chalk and were left running after dismissing the simulator paste prompt; Android remained resumed on Chalk home
2026-04-07 11:28:30 PKT | Investigated the Android NativeVideoConference render error and traced it to platform-split wrapper imports resolving directly to .android.tsx files that did not export the generic component names Metro expected
2026-04-07 11:28:30 PKT | Added generic alias exports to the Android and macOS split component files plus a regression test in packages/sdk-react-native/src/components/platform-split-exports.test.ts to guard the wrapper/export contract
2026-04-07 11:28:30 PKT | Verified the new regression test passes, then cleared Android logcat, restored adb reverse ports, relaunched the Expo dev client cleanly, and confirmed fresh startup logs plus a successful home-screen UI dump with no render overlay or invalid element error
