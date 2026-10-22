#!/usr/bin/env bash
# One queue-owned checkout; the dispatcher owns lifetime and cleanup, including after SIGKILL.
set -euo pipefail
work="$1" timeout_seconds="$2" browser="$3" min_free="$4"
shift 4
free="$(df -k "$work" | awk 'NR == 2 { printf "%d", $4 / 1048576 }')"
if ((free < min_free)); then
  echo "[remote] only ${free} GiB free, below ${min_free} GiB; refusing to start" >&2
  exit 75
fi
mkdir -p "${work}/tmp"
export TMPDIR="${work}/tmp" CI=true GOFLAGS=-buildvcs=false
git init -q "${work}/repo"
cd "${work}/repo"
git fetch -q "${work}/repo.bundle" refs/chalk-remote/base:refs/remotes/origin/master refs/chalk-remote/head:refs/heads/chalk-gate
git checkout -q chalk-gate
rm -f "${work}/repo.bundle"
source scripts/gates/remote-slot-env.sh
echo "[remote] checked out $(git rev-parse --short HEAD)"
echo "==> pnpm install (shared store)"
scripts/gates/with-timeout.sh "$timeout_seconds" "dependency setup" -- pnpm install --frozen-lockfile --prefer-offline
if [[ "$browser" == 1 ]]; then
  echo "==> playwright install chromium (shared cache)"
  scripts/gates/with-timeout.sh "$timeout_seconds" "Chromium setup" -- pnpm --dir sdks/typescript/client exec playwright install chromium
fi
echo "==> gate: $*"
exec scripts/gates/with-timeout.sh "$timeout_seconds" "remote gate" -- "$@"
