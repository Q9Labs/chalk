#!/usr/bin/env bash
set -euo pipefail

ARTIFACT_PATH="${1:-}"
[[ -n "$ARTIFACT_PATH" ]] || { echo "usage: $0 /path/to/transcription-dispatcher-<release>-<sha256>.zip [manifest]" >&2; exit 2; }
[[ -f "$ARTIFACT_PATH" ]] || { echo "artifact is missing: $ARTIFACT_PATH" >&2; exit 1; }
[[ ! -L "$ARTIFACT_PATH" ]] || { echo "artifact must be a regular file, not a symlink" >&2; exit 1; }

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  else shasum -a 256 "$1" | awk '{print $1}'; fi
}
ARTIFACT_BASENAME="$(basename "$ARTIFACT_PATH")"
[[ "$ARTIFACT_BASENAME" =~ ^transcription-dispatcher-[A-Za-z0-9][A-Za-z0-9._-]{7,127}-([0-9a-f]{64})\.zip$ ]] || { echo "artifact filename must include a unique release ID and lowercase SHA-256" >&2; exit 1; }
EXPECTED_DIGEST="${BASH_REMATCH[1]}"
[[ "${ARTIFACT_BASENAME,,}" != *latest* ]] || { echo "mutable latest artifact names are rejected" >&2; exit 1; }
ACTUAL_DIGEST="$(sha256_file "$ARTIFACT_PATH")"
[[ "$ACTUAL_DIGEST" == "$EXPECTED_DIGEST" ]] || { echo "artifact digest mismatch: filename=$EXPECTED_DIGEST bytes=$ACTUAL_DIGEST" >&2; exit 1; }

CHECKSUM_PATH="$ARTIFACT_PATH.sha256"
[[ -f "$CHECKSUM_PATH" ]] || { echo "missing checksum sidecar: $CHECKSUM_PATH" >&2; exit 1; }
grep -Fq "$ACTUAL_DIGEST  $ARTIFACT_BASENAME" "$CHECKSUM_PATH" || { echo "checksum sidecar does not match artifact" >&2; exit 1; }
MANIFEST_PATH="${2:-${ARTIFACT_PATH%.zip}.manifest.json}"
[[ -f "$MANIFEST_PATH" ]] || { echo "missing release manifest: $MANIFEST_PATH" >&2; exit 1; }
MANIFEST_DIGEST="$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.artifact?.sha256??"")' "$MANIFEST_PATH")"
MANIFEST_DIGEST_BASE64="$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.artifact?.sha256_base64??"")' "$MANIFEST_PATH")"
MANIFEST_FILENAME="$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.artifact?.filename??"")' "$MANIFEST_PATH")"
EXPECTED_BASE64="$(node -e 'process.stdout.write(Buffer.from(process.argv[1],"hex").toString("base64"))' "$ACTUAL_DIGEST")"
[[ "$MANIFEST_DIGEST" == "$ACTUAL_DIGEST" && "$MANIFEST_DIGEST_BASE64" == "$EXPECTED_BASE64" && "$MANIFEST_FILENAME" == "$ARTIFACT_BASENAME" ]] || { echo "release manifest does not describe this exact artifact" >&2; exit 1; }
SOURCE_STATE="$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.source_state??"")' "$MANIFEST_PATH")"
SOURCE_TREE_DIGEST="$(node -e 'const fs=require("node:fs");const x=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.stdout.write(x.source_tree_digest??"")' "$MANIFEST_PATH")"
if [[ "$SOURCE_STATE" == "dirty-local-proof" ]]; then
  [[ "${ALLOW_DIRTY_SOURCE:-0}" == "1" ]] || { echo "dirty-local-proof provenance is rejected for release verification" >&2; exit 1; }
  [[ "$SOURCE_TREE_DIGEST" =~ ^[0-9a-f]{64}$ ]] || { echo "dirty-local-proof provenance has no deterministic source digest" >&2; exit 1; }
elif [[ "$SOURCE_STATE" != "clean" ]]; then
  echo "release manifest has an invalid source_state" >&2
  exit 1
fi
echo "verified immutable transcription dispatcher artifact: $ARTIFACT_BASENAME"
echo "sha256: $ACTUAL_DIGEST"
