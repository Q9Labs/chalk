#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: scan-npm-tarballs.sh <tarball-dir> <gitleaks-config>" >&2
  exit 2
fi

tarball_dir="$1"
config="$2"
shopt -s nullglob
tarballs=("$tarball_dir"/*.tgz)
if (( ${#tarballs[@]} == 0 )); then
  echo "No npm tarballs found in ${tarball_dir} (*.tgz)." >&2
  exit 2
fi

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks_command=(gitleaks)
elif command -v go >/dev/null 2>&1; then
  gitleaks_command=(go run github.com/zricethezav/gitleaks/v8@v8.30.1)
else
  echo "Gitleaks is required. Install gitleaks or Go, then rerun the npm tarball scan." >&2
  exit 127
fi

temporary_directory="$(mktemp -d)"
trap 'rm -rf "$temporary_directory"' EXIT
scan_failed=0
for tarball in "${tarballs[@]}"; do
  extracted="${temporary_directory}/$(basename "${tarball%.tgz}")"
  mkdir -p "$extracted"
  if ! tar -xzf "$tarball" -C "$extracted"; then
    echo "Failed to extract npm tarball $(basename "$tarball")." >&2
    scan_failed=1
    continue
  fi
  if "${gitleaks_command[@]}" dir --config "$config" --redact --verbose --no-banner "$extracted"; then
    echo "No secrets found in $(basename "$tarball")."
  else
    echo "Secret scan failed for $(basename "$tarball")." >&2
    scan_failed=1
  fi
done

exit "$scan_failed"
