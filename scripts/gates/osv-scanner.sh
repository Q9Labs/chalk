#!/usr/bin/env bash
set -euo pipefail

args=(scan source --no-resolve)
while IFS= read -r -d '' file; do
  args+=(--lockfile "$file")
done < <(
  find . \
    \( -path './node_modules' -o -path '*/node_modules' \) -prune -o \
    \( -name 'go.mod' -o -name 'pnpm-lock.yaml' -o -name 'package-lock.json' -o -name 'yarn.lock' \) \
    -print0
)

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
