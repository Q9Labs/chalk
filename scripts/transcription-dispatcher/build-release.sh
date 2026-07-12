#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT_DIR/scripts/transcription-dispatcher"
APP_DIR="$ROOT_DIR/apps/transcription-dispatcher"
ARTIFACT_DIR="${ARTIFACT_DIR:-$ROOT_DIR/infrastructure/.artifacts/transcription-dispatcher}"
RELEASE_ID="${1:-${RELEASE_ID:-}}"

fail() { echo "transcription dispatcher release: $*" >&2; exit 1; }

[[ -n "$RELEASE_ID" ]] || fail "release ID is required (pass it as the first argument or RELEASE_ID)"
[[ "$RELEASE_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$ ]] || fail "release ID is invalid or not unique"
[[ "${RELEASE_ID,,}" != *latest* ]] || fail "mutable release ID latest is not allowed"
[[ -f "$APP_DIR/package.json" ]] || fail "dispatcher package is missing: $APP_DIR/package.json"
[[ -f "$APP_DIR/tsconfig.json" ]] || fail "dispatcher TypeScript config is missing: $APP_DIR/tsconfig.json"
command -v pnpm >/dev/null 2>&1 || fail "pnpm is required"
command -v zip >/dev/null 2>&1 || fail "zip is required"

SOURCE_REVISION="$(git -C "$ROOT_DIR" rev-parse HEAD 2>/dev/null || true)"
[[ "$SOURCE_REVISION" =~ ^[0-9a-f]{40}$ ]] || fail "could not resolve a full source revision"
SOURCE_STATE_JSON="$(node "$SCRIPT_DIR/source-state.mjs" "$ROOT_DIR" apps/transcription-dispatcher infrastructure scripts/transcription-dispatcher package.json pnpm-lock.yaml pnpm-workspace.yaml)"
SOURCE_STATE="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.source_state)' "$SOURCE_STATE_JSON")"
SOURCE_TREE_DIGEST="$(node -e 'const x=JSON.parse(process.argv[1]);process.stdout.write(x.source_tree_digest??"")' "$SOURCE_STATE_JSON")"
if [[ "$SOURCE_STATE" == "dirty-local-proof" ]]; then
  [[ "${ALLOW_DIRTY_SOURCE:-0}" == "1" ]] || fail "source tree is dirty; set ALLOW_DIRTY_SOURCE=1 only for an explicitly local proof"
  [[ "$SOURCE_TREE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || fail "dirty source digest is invalid"
fi
SOURCE_DATE_EPOCH="${SOURCE_DATE_EPOCH:-$(git -C "$ROOT_DIR" show -s --format=%ct HEAD 2>/dev/null || true)}"
[[ "$SOURCE_DATE_EPOCH" =~ ^[0-9]+$ ]] || fail "SOURCE_DATE_EPOCH must be a non-negative integer"

rm -rf "$ARTIFACT_DIR/.staging-$RELEASE_ID" "$ARTIFACT_DIR/.zip-$RELEASE_ID" "$ARTIFACT_DIR/.transcription-dispatcher-$RELEASE_ID.zip.tmp"
mkdir -p "$ARTIFACT_DIR" "$ARTIFACT_DIR/.staging-$RELEASE_ID/package" "$ARTIFACT_DIR/.zip-$RELEASE_ID"
STAGING_DIR="$ARTIFACT_DIR/.staging-$RELEASE_ID/package"

echo "building @chalk/transcription-dispatcher for $RELEASE_ID"
pnpm --dir "$APP_DIR" build
DIST_DIR="$APP_DIR/dist"
[[ -d "$DIST_DIR" ]] || fail "build completed without a dist directory"
[[ -f "$DIST_DIR/index.js" ]] || fail "build output is missing dist/index.js (Lambda handler index.handler)"
[[ ! -L "$DIST_DIR/index.js" ]] || fail "build output handler must be a regular file, not a symlink"
cp -R "$DIST_DIR/." "$STAGING_DIR/"
cp "$APP_DIR/package.json" "$STAGING_DIR/package.json"

ZIP_TMP="$ARTIFACT_DIR/.transcription-dispatcher-$RELEASE_ID.zip.tmp"
ZIP_DIR="$ARTIFACT_DIR/.zip-$RELEASE_ID"
cp -R "$STAGING_DIR/." "$ZIP_DIR/"
find "$ZIP_DIR" -type f -exec touch -t 198001010000 {} +
(
  cd "$ZIP_DIR"
  find . -type f -print | LC_ALL=C sort | zip -X -q "$ZIP_TMP" -@
)

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
ARTIFACT_SHA256="$(sha256_file "$ZIP_TMP")"
[[ "$ARTIFACT_SHA256" =~ ^[0-9a-f]{64}$ ]] || fail "could not calculate a lowercase SHA-256 digest"
ARTIFACT_NAME="transcription-dispatcher-$RELEASE_ID-$ARTIFACT_SHA256.zip"
ARTIFACT_PATH="$ARTIFACT_DIR/$ARTIFACT_NAME"
mv "$ZIP_TMP" "$ARTIFACT_PATH"
printf '%s  %s\n' "$ARTIFACT_SHA256" "$ARTIFACT_NAME" > "$ARTIFACT_PATH.sha256"

MANIFEST_ARGS=(--source-state "$SOURCE_STATE")
if [[ -n "$SOURCE_TREE_DIGEST" ]]; then
  MANIFEST_ARGS+=(--source-tree-digest "$SOURCE_TREE_DIGEST")
fi
node "$SCRIPT_DIR/emit-manifest.mjs" \
  --staging "$STAGING_DIR" --zip "$ARTIFACT_PATH" --sha256 "$ARTIFACT_SHA256" \
  --release-id "$RELEASE_ID" --source-revision "$SOURCE_REVISION" \
  "${MANIFEST_ARGS[@]}" \
  --source-date-epoch "$SOURCE_DATE_EPOCH" --output-dir "$ARTIFACT_DIR"
rm -rf "$ARTIFACT_DIR/.staging-$RELEASE_ID" "$ZIP_DIR"
echo "created immutable local artifact: $ARTIFACT_PATH"
echo "digest: $ARTIFACT_SHA256"
echo "manifest: ${ARTIFACT_PATH%.zip}.manifest.json"
