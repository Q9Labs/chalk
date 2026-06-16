#!/usr/bin/env bash
set -euo pipefail

if command -v gitleaks >/dev/null 2>&1; then
  exec gitleaks detect --source . --no-git --config .gitleaks.toml --redact --verbose
fi

if command -v go >/dev/null 2>&1; then
  exec go run github.com/zricethezav/gitleaks/v8@v8.30.1 detect --source . --no-git --config .gitleaks.toml --redact --verbose
fi

echo "Gitleaks is required. Install gitleaks or Go, then rerun pnpm run security:secrets." >&2
exit 127
