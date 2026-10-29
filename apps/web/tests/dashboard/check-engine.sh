#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run build --filter=@q9labsai/chalk-client...
http_started=$SECONDS
bash apps/web/tests/dashboard/real-engine.sh
printf 'DASHBOARD_ENGINE_TIMING http_seconds=%s\n' "$((SECONDS - http_started))"
refresh_started=$SECONDS
DASHBOARD_ENGINE_DEADLINE_SECONDS=600 bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/owner-refresh.mjs
printf 'DASHBOARD_ENGINE_TIMING refresh_seconds=%s\n' "$((SECONDS - refresh_started))"
