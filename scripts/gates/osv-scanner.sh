#!/usr/bin/env bash
set -euo pipefail

if command -v osv-scanner >/dev/null 2>&1; then
  # The transitive resolver currently crashes on the Python requirements file.
  exec osv-scanner scan source -r . --no-resolve
fi

if command -v go >/dev/null 2>&1; then
  # The transitive resolver currently crashes on the Python requirements file.
  exec go run github.com/google/osv-scanner/v2/cmd/osv-scanner@v2.3.8 scan source -r . --no-resolve
fi

echo "OSV-Scanner is required. Install osv-scanner or Go, then rerun pnpm run security:osv." >&2
exit 127
