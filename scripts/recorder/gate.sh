#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
tofu_dir="$repo_root/infrastructure/recorder"

python3 -m unittest discover -s "$repo_root/scripts/recorder" -p 'test_boot_check_host.py'

tofu -chdir="$tofu_dir" fmt -check -recursive
bash "$repo_root/scripts/recorder/tofu-init.sh" "$tofu_dir"
tofu -chdir="$tofu_dir" validate

# A local validation gate must remain closed by default. This proves the
# operational script cannot accidentally pass without staging evidence and
# scoped credentials, while keeping the values themselves out of logs.
if (cd "$repo_root" && node scripts/recorder/validate-config.mjs) >/dev/null 2>&1; then
  echo "recorder gate unexpectedly passed without staging credentials" >&2
  exit 1
fi

echo "recorder infrastructure validation passed; provider mutation remains disabled"
