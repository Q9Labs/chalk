#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
pnpm exec turbo run build --filter=web...
pnpm --filter web run check-types:dashboard
node apps/web/tests/dashboard/production-bundle.mjs
node apps/web/tests/dashboard/service-worker.mjs
bash apps/web/tests/dashboard/real-engine.sh
export GATE_BASE_REF="${CHALK_REMOTE_BASE_REF:-c9357055dca493bc5bf894f0539f72ba7d2b436b}"
pnpm exec bash scripts/gates/commit.sh --base "$GATE_BASE_REF"
