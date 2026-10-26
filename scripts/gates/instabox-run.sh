#!/usr/bin/env bash
# Bootstrap the disposable Linux snapshot, then run the requested Chalk command.
set -euo pipefail
if [[ "$(uname -s)" != Linux ]]; then
  echo 'Run this helper on Instabox through box run.' >&2
  exit 2
fi
cd "$(dirname "$0")/../.."
browser=0
if [[ "${1:-}" == --browser ]]; then browser=1; shift; fi
if (($# == 0)); then set -- pnpm gate:full; fi

# Queue proofs need 8 GB free and hard-link into paths fixed under /tmp.
# Keep both ends on one mount, backed by the snapshot's 20-GB data disk.
scratch="$(mktemp -d "$HOME/chalk-gate.XXXXXX")"
trap 'rm -rf -- "$scratch"' EXIT
chmod 1777 "$scratch"
sudo mount --bind "$scratch" /tmp
trap 'sudo umount /tmp && rm -rf -- "$scratch"' EXIT
export TMPDIR=/tmp
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
