#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tofu_dir="$repo_root/infrastructure/recorder"

tofu -chdir="$tofu_dir" fmt -check -recursive
tofu -chdir="$tofu_dir" init -backend=false -input=false -upgrade=false
tofu -chdir="$tofu_dir" validate
pnpm exec vitest run "$repo_root/scripts/recorder/validate-config.test.mjs"

# A local validation gate must remain closed by default. This proves the
# operational script cannot accidentally pass without staging evidence and
# scoped credentials, while keeping the values themselves out of logs.
if node "$repo_root/scripts/recorder/validate-config.mjs" >/dev/null 2>&1; then
  echo "recorder gate unexpectedly passed without staging credentials" >&2
  exit 1
fi

echo "recorder infrastructure validation passed; provider mutation remains disabled"
