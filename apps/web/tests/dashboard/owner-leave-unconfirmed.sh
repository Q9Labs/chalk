#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../../../.."
export DASHBOARD_ENGINE_DEADLINE_SECONDS="${DASHBOARD_ENGINE_DEADLINE_SECONDS:-900}"
exec bash apps/web/tests/dashboard/real-engine.sh node apps/web/tests/dashboard/owner-leave-unconfirmed.mjs
