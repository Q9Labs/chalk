#!/usr/bin/env bash
set -euo pipefail

commit="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short "$commit")"
title="$(git log -1 --pretty=%s "$commit")"
runs="${CODEX_REVIEW_RUNS:-1}"

if ! [[ "$runs" =~ ^[1-9][0-9]*$ ]]; then
  echo "CODEX_REVIEW_RUNS must be a positive integer; got '$runs'." >&2
  exit 2
fi

log_dir=".git/codex-reviews/$short_sha"
mkdir -p "$log_dir"

for run in $(seq 1 "$runs"); do
  log_file="$log_dir/run-$run.log"
  echo "Running Codex commit review $run/$runs for $short_sha: $title"
  codex review --commit "$commit" --title "$title" 2>&1 | tee "$log_file"
done
