#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
connect_helper="${repo_root}/.agents/skills/chalk-mobile-wireless-debug/scripts/connect-wireless-adb.sh"
package_name="${CHALK_MOBILE_PACKAGE:-}"
variant="debug"
connect_target=""
pair_target=""
pair_code=""
skip_build="false"
launch_app="true"
delivery_mode="push"
remote_dir="/sdcard/Download"
remote_basename=""
delivery_result=""

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
    --install)
      delivery_mode="install"
      shift
      ;;
    --push)
      delivery_mode="push"
      shift
      ;;
    --remote-dir)
      remote_dir="${2:-}"
      shift 2
      ;;
    --remote-name)
      remote_basename="${2:-}"
      shift 2
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
  --install            Try adb install first instead of default push flow
  --push               Push APK to phone storage instead of adb install
  --remote-dir <path>  Remote directory for pushed APK (default: /sdcard/Download)
  --remote-name <apk>  Remote filename for pushed APK
  --no-launch          Skip launching the app after install

Examples:
  bash scripts/mobile-install-local-apk.sh --connect 192.168.18.140:43299
  bash scripts/mobile-install-local-apk.sh --install --connect 192.168.18.140:43299
  bash scripts/mobile-install-local-apk.sh --push --connect 192.168.18.140:43299
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
  echo "No connected adb device found. Use --connect or pnpm run mobile:connect first." >&2
  exit 1
fi

gradle_task="assembleDebug"
apk_path="${repo_root}/apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk"
install_flags=(-r -t -g)

if [[ "$variant" == "release" ]]; then
  gradle_task="assembleRelease"
  apk_path="${repo_root}/apps/mobile/android/app/build/outputs/apk/release/app-release.apk"
fi

if [[ -z "$remote_basename" ]]; then
  stamp="$(date +%Y%m%d-%H%M%S)"
  rand="$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"
  remote_basename="chalk-mobile-${variant}-${stamp}-${rand}.apk"
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

remote_path="${remote_dir%/}/${remote_basename}"
install_output=""

push_and_open() {
  adb -s "$serial" push "$apk_path" "$remote_path" >/dev/null
  adb -s "$serial" shell am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d "file://${remote_path}" >/dev/null 2>&1 || true
  adb -s "$serial" shell am start -a android.intent.action.VIEW -d "file://${remote_path}" -t "application/vnd.android.package-archive" >/dev/null 2>&1 || true
  delivery_result="push"
  printf 'delivery=%s\n' "push"
  printf 'remote_apk=%s\n' "$remote_path"
}

if [[ "$delivery_mode" == "push" ]]; then
  push_and_open
else
  set +e
  install_output="$(adb -s "$serial" install "${install_flags[@]}" "$apk_path" 2>&1)"
  install_status=$?
  set -e

  if [[ $install_status -ne 0 ]]; then
    if [[ "$install_output" == *"INSTALL_FAILED_USER_RESTRICTED"* ]]; then
      echo "$install_output" >&2
      echo "adb install blocked by device policy; falling back to push-to-downloads" >&2
      push_and_open
    else
      echo "$install_output" >&2
      exit $install_status
    fi
  else
    delivery_result="install"
    printf '%s\n' "$install_output"
  fi
fi

if [[ "$launch_app" == "true" && "$delivery_result" != "push" ]]; then
  if [[ -z "$package_name" ]]; then
    echo "Set CHALK_MOBILE_PACKAGE to launch after install, or pass --no-launch." >&2
    exit 1
  fi
  adb -s "$serial" shell monkey -p "$package_name" -c android.intent.category.LAUNCHER 1 >/dev/null
fi

printf 'serial=%s\n' "$serial"
printf 'apk=%s\n' "$apk_path"
printf 'variant=%s\n' "$variant"
