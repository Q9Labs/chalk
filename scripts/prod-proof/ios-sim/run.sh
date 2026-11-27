#!/usr/bin/env bash
# Opens a page in iPhone Safari on an iOS Simulator and taps Allow on the camera and microphone prompts.
# Run it on a Mac with Xcode and xcodegen (the Mac mini). Usage:
#   [PROOF_REOPEN_AFTER=<seconds>] opens the URL again after that long, which is a reload and rejoin.
#   [PROOF_TAP_TO_HEAR=1] also taps the "Click to hear the call" notice, the user gesture iOS needs before it plays sound.
#   [PROOF_TAP_CENTER_AT=<seconds>] taps the middle of the page once, a plain user gesture for autoplay checks.
#   PROOF_URL='https://...' [PROOF_SECONDS=90] [PROOF_OUT=./out] [PROOF_DEVICE=<udid|name>] ./run.sh
# Writes shot-NNN.png, ui-test.log and simulator.mp4 to PROOF_OUT. Exit code 0 means the UI test ran to the end;
# read ui-test.log for how many prompts it allowed.
set -euo pipefail

: "${PROOF_URL:?set PROOF_URL to the page to open in Safari}"
seconds="${PROOF_SECONDS:-90}"
out="$(mkdir -p "${PROOF_OUT:-./out}" && cd "${PROOF_OUT:-./out}" && pwd)"
device="${PROOF_DEVICE:-booted}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

if [ "$device" = booted ]; then
  udid="$(xcrun simctl list devices booted | grep -Eo '[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}' | head -1 || true)"
  [ -n "$udid" ] || { echo "no booted simulator: boot one or set PROOF_DEVICE" >&2; exit 2; }
else
  udid="$device"
  xcrun simctl boot "$udid" 2>/dev/null || true
fi

cp -R "$here/project.yml" "$here/Host" "$here/Tests" "$work/"
(cd "$work" && xcodegen generate --quiet)
(cd "$work" && xcodebuild build-for-testing -quiet -project ChalkIOSProof.xcodeproj -scheme ChalkIOSProof \
  -destination "id=$udid" -derivedDataPath "$work/derived" >"$out/build.log" 2>&1) || { tail -20 "$out/build.log" >&2; exit 3; }

xcrun simctl io "$udid" recordVideo --codec=h264 --force "$out/simulator.mp4" >"$out/record.log" 2>&1 &
recorder=$!
cleanup_recorder() { kill -INT "$recorder" 2>/dev/null || true; wait "$recorder" 2>/dev/null || true; }
trap 'cleanup_recorder; rm -rf "$work"' EXIT

xcrun simctl openurl "$udid" "$PROOF_URL"
if [ -n "${PROOF_REOPEN_AFTER:-}" ]; then
  (sleep "$PROOF_REOPEN_AFTER" && xcrun simctl openurl "$udid" "$PROOF_URL") &
fi
export TEST_RUNNER_PROOF_SECONDS="$seconds" TEST_RUNNER_PROOF_OUT="$out" TEST_RUNNER_PROOF_TAP_TO_HEAR="${PROOF_TAP_TO_HEAR:-0}" TEST_RUNNER_PROOF_TAP_CENTER_AT="${PROOF_TAP_CENTER_AT:-}"
status=0
(cd "$work" && xcodebuild test-without-building -quiet -project ChalkIOSProof.xcodeproj -scheme ChalkIOSProof \
  -destination "id=$udid" -derivedDataPath "$work/derived" >"$out/test.log" 2>&1) || status=$?
cleanup_recorder
[ -f "$out/ui-test.log" ] && cat "$out/ui-test.log"
exit "$status"
