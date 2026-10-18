#!/usr/bin/env bash
set -euo pipefail
mkdir -p artifacts
pnpm exec turbo run build --filter=@q9labsai/chalk-client
pnpm --filter web run check-types:dashboard
pnpm --dir apps/web exec wrangler pages functions build --outfile ../../artifacts/dashboard-production.js
node apps/web/tests/dashboard/production-bundle.mjs
pnpm --filter web run test:dashboard
export GATE_BASE_REF="$(git merge-base "${CHALK_REMOTE_BASE_REF:-origin/master}" HEAD)"
pnpm exec bash scripts/gates/commit.sh --base "$GATE_BASE_REF"
