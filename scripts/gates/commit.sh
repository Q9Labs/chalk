#!/usr/bin/env bash
set -euo pipefail

pnpm run check:tracker
pnpm run test:tracker

if [[ "${1:-}" == "--" ]]; then
  shift
fi
exec q9gate run "$@"
