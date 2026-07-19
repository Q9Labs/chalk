#!/usr/bin/env bash
set -euo pipefail

args=(scan source --no-resolve)
while IFS= read -r -d '' file; do
  args+=(--lockfile "$file")
done < <(git ls-files -z | while IFS= read -r -d '' file; do
  case "${file}" in
    go.mod | */go.mod | pnpm-lock.yaml | */pnpm-lock.yaml | package-lock.json | */package-lock.json | yarn.lock | */yarn.lock)
      printf '%s\0' "${file}"
      ;;
  esac
done)

if [ "${#args[@]}" -eq 3 ]; then
  args=(scan source --recursive --no-resolve --allow-no-lockfiles .)
fi

if command -v osv-scanner >/dev/null 2>&1; then
  # The transitive resolver currently crashes on the Python requirements file.
  exec osv-scanner "${args[@]}"
fi

if command -v go >/dev/null 2>&1; then
  # The transitive resolver currently crashes on the Python requirements file.
  exec go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.3.8 "${args[@]}"
fi

echo "OSV-Scanner is required. Install osv-scanner or Go, then rerun pnpm run security:osv." >&2
exit 127
