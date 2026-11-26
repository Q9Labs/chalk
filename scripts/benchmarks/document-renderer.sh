#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FIXTURE="${1:-$ROOT/apps/document-renderer/testdata/benchmark-50.pdf}"
BINARY="${RENDERER_BINARY:-$ROOT/releases/document-renderer/work/bootstrap}"
if [[ ! -x "$BINARY" ]]; then
  echo "build first with scripts/build-document-renderer.sh or set RENDERER_BINARY" >&2
  exit 2
fi
export RENDER_BENCHMARK_FILE="$FIXTURE"
for mode in page full; do
  for run in 1 2 3; do
    output="$(RENDER_BENCHMARK_MODE="$mode" "$BINARY")"
    printf 'mode=%s run=%d %s\n' "$mode" "$run" "$output"
  done
done
