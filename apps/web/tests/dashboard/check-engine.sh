#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run build --filter=@q9labsai/chalk-client...
# The refresh proof waits five real minutes, so it runs beside the HTTP proof on its own
# database, ports, binary and logs. Compile Sync once so the two runs do not race on _build.
started=$SECONDS
(cd apps/sync && MIX_ENV=dev mix deps.get && MIX_ENV=dev mix compile)
bash apps/web/tests/dashboard/real-engine.sh &
http_pid=$!
(
  # Five consecutive ports; remote-slot-env.sh moves the block into the slot's own range.
  refresh_port=${CHALK_DASHBOARD_REFRESH_PORT_BASE:-18180}
  export CHALK_DASHBOARD_API_PORT=$refresh_port CHALK_DASHBOARD_VENDOR_PORT=$((refresh_port + 1))
  export CHALK_DASHBOARD_BRIDGE_PORT=$((refresh_port + 2))
  export CHALK_JOIN_WEB_PORT=$((refresh_port + 3)) CHALK_JOIN_SYNC_PORT=$((refresh_port + 4))
  export DASHBOARD_ENGINE_ARTIFACT_SUFFIX=-refresh DASHBOARD_ENGINE_DEADLINE_SECONDS=600
  bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/owner-refresh.mjs 2>&1 | sed -u 's/^/[refresh] /'
) &
refresh_pid=$!
http_status=0
refresh_status=0
wait "$http_pid" || http_status=$?
printf 'DASHBOARD_ENGINE_TIMING http_seconds=%s\n' "$((SECONDS - started))"
wait "$refresh_pid" || refresh_status=$?
printf 'DASHBOARD_ENGINE_TIMING refresh_seconds=%s\n' "$((SECONDS - started))"
((http_status == 0 && refresh_status == 0)) || { echo "dashboard engine failed: http=$http_status refresh=$refresh_status" >&2; exit 1; }
