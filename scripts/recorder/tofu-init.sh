#!/usr/bin/env bash
# Initializes an OpenTofu directory without a backend. A provider download from github.com can fail for a moment, and
# OpenTofu gives up after a few seconds, so this retries the whole init a bounded number of times.
set -euo pipefail

dir="${1:?usage: tofu-init.sh <directory>}"

# The waits between attempts are seconds; the last attempt has none. The test shortens them.
for delay in ${TOFU_INIT_DELAYS:-10 30 0}; do
  if tofu -chdir="$dir" init -backend=false -input=false -upgrade=false; then
    exit 0
  fi
  if [[ "$delay" == 0 ]]; then break; fi
  echo "tofu init failed in $dir; retrying in ${delay}s" >&2
  sleep "$delay"
done

echo "tofu init failed in $dir after 3 attempts" >&2
exit 1
