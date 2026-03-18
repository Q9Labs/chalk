---
name: chalk-mobile-wireless-debug
description: Pair, reconnect, relaunch, and debug `apps/mobile` on a real Android phone over wireless adb. Use when Hasan asks to pair a phone again, reconnect wireless debugging, install/relaunch the Chalk Android dev build, mirror with scrcpy, or run device-side adb/logcat/input commands without a cable.
---

# Chalk Mobile Wireless Debug

Use this for Chalk Android real-device work over Wi-Fi.

Primary scope:

- wireless adb pairing/reconnect
- Chalk dev-client relaunch
- on-device install/logcat/input/screenshot flow
- optional `scrcpy` mirror/control

Primary files:

- `apps/mobile/package.json`
- `apps/mobile/app.config.ts`
- `apps/mobile/android/app/src/main/AndroidManifest.xml`

Helpers:

- `scripts/connect-wireless-adb.sh`
- `scripts/launch-chalk-mobile-dev.sh`

## Defaults

- prefer wireless adb over cable once phone is paired
- prefer real phone over emulator when Hasan explicitly wants on-device behavior
- keep Metro running via `NODE_ENV=development bun run dev:mobile`
- use package `ai.q9labs.chalk.mobile`
- use scheme `exp+chalk-mobile://expo-development-client`

## Reconnect Flow

1. Discover wireless adb service:
   - `adb mdns services`
2. Reconnect to an already-paired phone:
   - `bash .codex/skills/chalk-mobile-wireless-debug/scripts/connect-wireless-adb.sh`
3. If only pairing service is shown on the phone UI, pair first:
   - `adb pair <ip:pair-port>`
   - enter the pairing code from the phone
   - then rerun `connect-wireless-adb.sh`
4. Verify:
   - `adb devices -l`

If multiple phones are visible, pass an IP filter:

```bash
bash .codex/skills/chalk-mobile-wireless-debug/scripts/connect-wireless-adb.sh 192.168.18.
```

If MIUI stops advertising over mDNS, the helper falls back to the last successful endpoint automatically.

## Relaunch Chalk Dev Build

1. Start Metro from repo root if needed:
   - `NODE_ENV=development bun run dev:mobile`
2. Relaunch on the connected phone:
   - `bash .codex/skills/chalk-mobile-wireless-debug/scripts/launch-chalk-mobile-dev.sh`
3. Verify foreground activity:
   - `adb shell dumpsys activity activities | rg 'mResumedActivity|ai\\.q9labs\\.chalk\\.mobile/.MainActivity'`

What the launch helper does:

- picks a connected device if `ADB_SERIAL` is unset
- derives the Mac LAN IP
- opens `exp+chalk-mobile://expo-development-client/?url=http://<host-ip>:8081`
- targets `ai.q9labs.chalk.mobile`

## Install / Debug Commands

Install debug APK:

```bash
adb -s <serial> install -r -t -g apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Watch logs:

```bash
adb -s <serial> logcat | rg 'ReactNativeJS|chalk|Expo'
```

Tap / swipe:

```bash
adb -s <serial> shell input tap 500 1200
adb -s <serial> shell input swipe 500 1600 500 400
```

Screenshot:

```bash
adb -s <serial> exec-out screencap -p > phone.png
```

## scrcpy

If installed:

```bash
scrcpy -s <serial>
```

Install with Homebrew when needed:

```bash
brew install scrcpy
```

## Chalk-Specific Notes

- `bun run dev:mobile` already tries `adb reverse tcp:8080` and `tcp:8081`
- mobile runtime also rewrites device-local URLs using the Metro host
- local API default is `http://localhost:8080`
- wireless adb device serial is usually `<phone-ip>:<port>` and changes over time
- if the device disappears, rerun `adb mdns services` then reconnect
- if the phone shows the Expo dev launcher instead of Chalk content, relaunch with `launch-chalk-mobile-dev.sh`

## When To Ask Hasan

- when the phone is not advertising over `adb mdns services`
- when the phone needs a one-time pairing code from the device UI
- when wireless debugging keeps dropping and Hasan may need to toggle it off/on
- when Xiaomi/MIUI security prompts require manual confirmation

## Success Criteria

- phone appears in `adb devices -l`
- Metro reachable on `:8081`
- Chalk app launches into `MainActivity`
- logs or UI confirm real app activity, not just the dev launcher shell
