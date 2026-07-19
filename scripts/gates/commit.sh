#!/usr/bin/env bash
set -euo pipefail

exec node scripts/gates/smart-gate.mjs "$@"
