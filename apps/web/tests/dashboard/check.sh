#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
pnpm exec turbo run build --filter=web...
pnpm --filter web run check-types:dashboard
node apps/web/tests/dashboard/production-bundle.mjs
node apps/web/tests/dashboard/service-worker.mjs
bash apps/web/tests/dashboard/real-engine.sh
pnpm exec bash scripts/gates/commit.sh --base origin/master
