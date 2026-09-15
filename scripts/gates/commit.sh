#!/usr/bin/env bash
set -euo pipefail

pnpm run check:tracker
pnpm run test:tracker

exec node scripts/gates/smart-gate.mjs "$@"
