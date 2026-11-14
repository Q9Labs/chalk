#!/usr/bin/env bash
# check-engine.sh http     the dashboard against the real API, Sync and Pages runtime (about 1 minute of tests)
# check-engine.sh refresh  the owner call across the real five-minute media-access lifetime (about 5 minutes of waiting)
# check-engine.sh board    the two board proofs of tests/board.e2e.ts that need no proof API key, in a browser (about 3 minutes)
# The Gate runs them as three lanes so a pull request waits only for the ones its inputs select.
set -euo pipefail
cd "$(dirname "$0")/../../../.."
proof="${1:-}"
pnpm exec turbo run build --filter=@q9labsai/chalk-client...
# A Hex download can fail for a moment, so a failed fetch is retried a bounded number of times.
for delay in 10 30 0; do
  (cd apps/sync && MIX_ENV=dev mix deps.get) && break
  ((delay)) || exit 1
  echo "mix deps.get failed; retrying in ${delay}s" >&2
  sleep "$delay"
done
(cd apps/sync && MIX_ENV=dev mix compile)
case "$proof" in
  http) bash apps/web/tests/dashboard/real-engine.sh ;;
  refresh)
    # Five consecutive ports; remote-slot-env.sh moves the block into the slot's own range.
    refresh_port=${CHALK_DASHBOARD_REFRESH_PORT_BASE:-18180}
    export CHALK_DASHBOARD_API_PORT=$refresh_port CHALK_DASHBOARD_VENDOR_PORT=$((refresh_port + 1))
    export CHALK_DASHBOARD_BRIDGE_PORT=$((refresh_port + 2))
    export CHALK_JOIN_WEB_PORT=$((refresh_port + 3)) CHALK_JOIN_SYNC_PORT=$((refresh_port + 4))
    export DASHBOARD_ENGINE_ARTIFACT_SUFFIX=-refresh DASHBOARD_ENGINE_DEADLINE_SECONDS=600
    bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/owner-refresh.mjs
    ;;
  board)
    # The board proofs of tests/board.e2e.ts that need no proof API key, against the same local stack. The web engine and the
    # fixture browser each need their own Chromium.
    node scripts/ensure-playwright-browsers.mjs sdk chromium
    node scripts/ensure-playwright-browsers.mjs engine chromium
    bash apps/web/tests/dashboard/real-engine.sh node scripts/web-proof/board-local.mjs
    ;;
  *)
    echo "usage: check-engine.sh http|refresh|board" >&2
    exit 2
    ;;
esac
