#!/usr/bin/env bash
set -euo pipefail

# Git worktrees break Go VCS stamping (exit 128); no gate lane needs stamped binaries.
export GOFLAGS="${GOFLAGS:--buildvcs=false}"
cd "$(dirname "$0")/../.."
node scripts/gates/check-install.mjs

node scripts/gates/doclint.mjs

if [[ "${1:-}" == "--" ]]; then
  shift
fi

# --fast is the pre-commit profile: only the lanes that finish in about a second and are staged-scoped.
# Everything else, including the generated-files check, runs in the Gate workflow on the pull request, or via pnpm run gate.
if [[ "${1:-}" == "--fast" ]]; then
  shift
  pnpm run check:tracker
  exec q9gate run --lane scope --lane format --lane hygiene --lane secrets "$@"
fi

pnpm run check:tracker
exec q9gate run "$@"
