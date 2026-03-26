#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connect_helper="${repo_root}/.codex/skills/chalk-mobile-wireless-debug/scripts/connect-wireless-adb.sh"
package_name="${CHALK_MOBILE_PACKAGE:-ai.q9labs.chalk.mobile}"
variant="debug"
connect_target=""
pair_target=""
pair_code=""
skip_build="false"
launch_app="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --release)
      variant="release"
      shift
      ;;
    --debug)
      variant="debug"
      shift
      ;;
    --connect)
      connect_target="${2:-}"
      shift 2
      ;;
    --pair)
      pair_target="${2:-}"
      shift 2
      ;;
    --code)
      pair_code="${2:-}"
      shift 2
      ;;
    --skip-build)
      skip_build="true"
      shift
      ;;
    --no-launch)
      launch_app="false"
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: bash scripts/mobile-install-local-apk.sh [options]

Options:
  --debug              Build/install debug APK (default)
  --release            Build/install local release APK
  --connect <ip:port>  Connect to a paired wireless adb endpoint first
  --pair <ip:port>     Pair to wireless adb endpoint first
  --code <6-digit>     Pairing code for --pair
  --skip-build         Install existing APK without rebuilding
  --no-launch          Skip launching the app after install

Examples:
  bash scripts/mobile-install-local-apk.sh --connect 192.168.18.140:43299
  bash scripts/mobile-install-local-apk.sh --pair 192.168.18.140:32965 --code 665929 --connect 192.168.18.140:43299
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -n "$pair_target" ]]; then
  if [[ -z "$pair_code" ]]; then
    echo "--pair requires --code" >&2
    exit 1
  fi
  adb pair "$pair_target" "$pair_code"
fi

if [[ -n "$connect_target" ]]; then
  bash "$connect_helper" "$connect_target" >/dev/null
fi

serial="${ADB_SERIAL:-}"
if [[ -z "$serial" ]]; then
  serial="$(adb devices | awk 'NR > 1 && $2 == "device" {print $1; exit}')"
fi

if [[ -z "$serial" ]]; then
  echo "No connected adb device found. Use --connect or bun run mobile:connect first." >&2
  exit 1
fi

gradle_task="assembleDebug"
apk_path="${repo_root}/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
install_flags=(-r -t -g)

if [[ "$variant" == "release" ]]; then
  gradle_task="assembleRelease"
  apk_path="${repo_root}/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
fi

if [[ "$skip_build" != "true" ]]; then
  (
    cd "${repo_root}/apps/mobile/android"
    ./gradlew "$gradle_task"
  )
fi

if [[ ! -f "$apk_path" ]]; then
  echo "APK not found at $apk_path" >&2
  exit 1
fi

adb -s "$serial" install "${install_flags[@]}" "$apk_path"

if [[ "$launch_app" == "true" ]]; then
  adb -s "$serial" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
fi

printf 'serial=%s\n' "$serial"
printf 'apk=%s\n' "$apk_path"
printf 'variant=%s\n' "$variant"
