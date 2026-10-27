#!/usr/bin/env bash
set -euo pipefail

root=$(mktemp -d "${TMPDIR:-/tmp}/chalk-play-test.XXXXXX")
trap 'rm -rf -- "$root"' EXIT
mkdir -p "$root/bin" "$root/repo/apps/mobile/scripts/release" "$root/tmp"
cp "$(dirname "$0")/publish-nightly-android.sh" "$root/repo/apps/mobile/scripts/release/"
cat > "$root/bin/curl" <<'EOF'
#!/usr/bin/env bash
cp "$FAKE_GPLAY" "${!#}"
EOF
cat > "$root/bin/sha256sum" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat > "$root/bin/gh" <<'EOF'
#!/usr/bin/env bash
printf '[{"sha":"%s","payload":{"proof_run_id":"%s","proof_result":"passed"}}]\n' "${GH_CURRENT_SHA:-$SOURCE_SHA}" "$SOURCE_RUN"
EOF
cat > "$root/gplay" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$1 $2" in
  'edits create') echo '{"id":"test"}' ;;
  'edits delete') echo null ;;
  'bundles list') echo '{"bundles":[{"versionCode":40}]}' ;;
  'apks list') echo '{"apks":[{"versionCode":41}]}' ;;
  'tracks get')
    if [[ -e "$STATE" ]]; then echo '{"releases":[{"name":"nightly-123","status":"completed","versionCodes":["42"]}]}';
    else echo '{"releases":[]}'; fi ;;
  'publish track') printf '%s\n' "$*" > "$STATE" ;;
  *) exit 1 ;;
esac
EOF
cat > "$root/repo/apps/mobile/scripts/release/build-signed-android.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[[ "$CHALK_APP_VARIANT" == nightly && "$CHALK_ANDROID_VERSION_CODE" == 42 ]]
mkdir -p "$SIGNED_OUTPUT_DIR"
touch "$SIGNED_OUTPUT_DIR/fixture.aab"
EOF
chmod +x "$root/bin/curl" "$root/bin/sha256sum" "$root/bin/gh" "$root/gplay"
export PATH="$root/bin:$PATH" FAKE_GPLAY="$root/gplay" STATE="$root/state" RUNNER_TEMP="$root/tmp"
export SOURCE_RUN=123 SOURCE_SHA=abcdef1234567890 PLAY_CREDENTIALS='{}'
export GITHUB_REPOSITORY=example/chalk
cd "$root/repo"
bash apps/mobile/scripts/release/publish-nightly-android.sh
grep -q -- '--track internal' "$STATE"
grep -q -- '--version-name nightly-123' "$STATE"
PLAY_CREDENTIALS='{}' bash apps/mobile/scripts/release/publish-nightly-android.sh
if GH_CURRENT_SHA=stale PLAY_CREDENTIALS='{}' bash apps/mobile/scripts/release/publish-nightly-android.sh 2>/dev/null; then
  echo 'A stale nightly was not rejected.' >&2
  exit 1
fi
echo 'Android nightly internal publication regression passed.'
