#!/usr/bin/env bash
# Bootstrap the disposable Linux snapshot, then run the requested Chalk command.
set -euo pipefail
cd "$(dirname "$0")/../.."
browser=0
if [[ "${1:-}" == --browser ]]; then browser=1; shift; fi
if (($# == 0)); then set -- pnpm gate:full; fi

# /tmp is a 4-GB tmpfs on Instabox; queue proofs require an 8-GB admission floor.
# Put test scratch space on the 20-GB data disk instead.
export TMPDIR
TMPDIR="$(mktemp -d "$HOME/chalk-gate.XXXXXX")"
trap 'rm -rf -- "$TMPDIR"' EXIT
export GOTOOLCHAIN=auto
if ! command -v ruby >/dev/null || ! command -v lsof >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ruby lsof
fi
pnpm install --frozen-lockfile
if ((browser)); then
  pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium
fi
"$@"
