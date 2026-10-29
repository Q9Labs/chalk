#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
pnpm exec turbo run build --filter=@q9labsai/chalk-client...
bash apps/web/tests/dashboard/real-engine.sh
DASHBOARD_ENGINE_DEADLINE_SECONDS=600 bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/owner-refresh.mjs
