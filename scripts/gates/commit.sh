#!/usr/bin/env bash
set -euo pipefail

# Git worktrees break Go VCS stamping (exit 128); no gate lane needs stamped binaries.
export GOFLAGS="${GOFLAGS:--buildvcs=false}"
cd "$(dirname "$0")/../.."
node scripts/gates/check-install.mjs

if [[ "${1:-}" == "--" ]]; then
  shift
fi

# --fast is the pre-commit profile: only the lanes that are quick and staged-scoped.
# Everything else runs in the Gate workflow on the pull request, or via pnpm run gate.
if [[ "${1:-}" == "--fast" ]]; then
  shift
  pnpm run check:tracker
  exec q9gate run --lane scope --lane format --lane hygiene --lane secrets --lane language-ratchet --lane generated "$@"
fi

pnpm run check:tracker
pnpm run test:tracker
exec q9gate run "$@"
