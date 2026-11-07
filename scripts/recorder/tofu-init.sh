#!/usr/bin/env bash
# Initializes an OpenTofu directory without a backend. A provider download from github.com can fail for a moment, and
# OpenTofu gives up after a few seconds, so this retries the whole init a bounded number of times.
set -euo pipefail

dir="${1:?usage: tofu-init.sh <directory>}"

for delay in 10 30 0; do
  if tofu -chdir="$dir" init -backend=false -input=false -upgrade=false; then
    exit 0
  fi
  ((delay)) || break
  echo "tofu init failed in $dir; retrying in ${delay}s" >&2
  sleep "$delay"
done

echo "tofu init failed in $dir after 3 attempts" >&2
exit 1
