#!/usr/bin/env bash
# The Gate's board-e2e lane: build this checkout's web app, serve it, and run tests/board.e2e.ts against the staging
# API and Sync with the browser routed to the local build (CHALK_PROOF_LOCAL_WEB_URL in tests/board.e2e.ts).
set -euo pipefail
if [[ "${CHALK_PROOF_CONFIG_SOURCE:-}" != env ]]; then
  echo "board-e2e: needs the staging proof configuration (CHALK_PROOF_CONFIG_SOURCE=env and its CHALK_PROOF_* values)" >&2
  exit 1
fi
port="${CHALK_BOARD_GATE_PORT:-4173}"
pnpm --filter web run build
pnpm --filter web exec vite preview --strictPort --port "$port" >/dev/null 2>&1 &
preview=$!
trap 'kill "$preview" 2>/dev/null || true' EXIT
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:$port/" && break
  sleep 1
done
curl -fsS -o /dev/null "http://127.0.0.1:$port/"
CHALK_E2E_ONLY=board CHALK_PROOF_LOCAL_WEB_URL="http://127.0.0.1:$port" node scripts/web-proof/run.mjs
