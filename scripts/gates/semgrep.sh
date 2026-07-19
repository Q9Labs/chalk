#!/usr/bin/env bash
set -euo pipefail

if command -v semgrep >/dev/null 2>&1; then
  exec semgrep scan --config .semgrep --error "$@"
fi

if command -v uvx >/dev/null 2>&1; then
  exec uvx semgrep scan --config .semgrep --error "$@"
fi

echo "Semgrep is required. Install semgrep or uv, then rerun pnpm run static:semgrep." >&2
exit 127
