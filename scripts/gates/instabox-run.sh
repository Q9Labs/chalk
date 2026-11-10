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
# Parallel lanes (OSV, Go and browser proofs) can briefly need more than a 4 GiB machine has.
# Swap on the data disk turns that spike into a slow moment instead of a killed lane.
if [[ "$(swapon --show --noheadings | wc -l)" == 0 ]]; then
  swapfile="$scratch/swapfile"
  sudo fallocate -l 3G "$swapfile"
  sudo chmod 600 "$swapfile"
  sudo mkswap "$swapfile" >/dev/null
  sudo swapon "$swapfile"
  trap 'sudo swapoff "$swapfile"; sudo umount /tmp && rm -rf -- "$scratch"' EXIT
fi
export TMPDIR=/tmp
export GOTOOLCHAIN=auto
# Most test files wait on timers and sockets, so extra Vitest workers cost about 100 MB each and shorten the run:
# the Client suite takes 158 s with 1 worker, 82 s with 2 and 47 s with 4.
export VITEST_MAX_WORKERS="${VITEST_MAX_WORKERS:-4}"
if ! command -v ruby >/dev/null || ! command -v lsof >/dev/null; then
  sudo apt-get update -qq
  sudo apt-get install -y -qq ruby lsof
fi
pnpm install --frozen-lockfile
if ((browser)); then
  pnpm --dir sdks/typescript/client exec playwright install --with-deps chromium
fi
"$@"
