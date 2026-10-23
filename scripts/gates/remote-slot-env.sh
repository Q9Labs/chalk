#!/usr/bin/env bash
# Sourced by the worker. Dedicated blocks never overlap legacy harness defaults.
if [[ -n "${CHALK_REMOTE_SLOT:-}" ]]; then
  [[ "$CHALK_REMOTE_SLOT" =~ ^[0-9]+$ ]] && ((CHALK_REMOTE_SLOT < 100)) || return 2
  slot_base=$((21000 + CHALK_REMOTE_SLOT * 100))
  export CHALK_DEV_API_PORT=$((slot_base + 1)) CHALK_DEV_SYNC_PORT=$((slot_base + 2))
  export CHALK_DEV_WEB_PORT=$((slot_base + 3)) CHALK_DEV_POSTGRES_PORT=$((slot_base + 4))
  export CHALK_DEV_REDIS_PORT=$((slot_base + 5)) CHALK_DEV_PROVIDER_BRIDGE_PORT=$((slot_base + 6))
  export CHALK_API_SMOKE_ADDR="127.0.0.1:$((slot_base + 7))"
  export CHALK_CALL_STATES_PORT=$((slot_base + 8)) CHALK_CALL_LAYOUT_PORT=$((slot_base + 9))
  export CHALK_CALL_INTEGRATION_PORT=$((slot_base + 10)) FIXTURE_PORT=$((slot_base + 11))
  export CHALK_SMOKE_PORT=$((slot_base + 12)) CHALK_DASHBOARD_API_PORT=$((slot_base + 13))
  export CHALK_DASHBOARD_VENDOR_PORT=$((slot_base + 14)) CHALK_DASHBOARD_BRIDGE_PORT=$((slot_base + 15))
  export CHALK_JOIN_WEB_PORT=$((slot_base + 16)) CHALK_JOIN_SYNC_PORT=$((slot_base + 17)) CHALK_OAUTH_PORT=$((slot_base + 18))
  # Expo CLI binds Metro here and passes the port to Android builds. iOS Debug builds use the
  # prebuilt React Native core, which keeps 8081, so `pnpm ios` passes -RCT_jsLocation at launch.
  export RCT_METRO_PORT=$((slot_base + 19))
  export CHALK_API_ADDR="127.0.0.1:${CHALK_DEV_API_PORT}" CHALK_SYNC_PORT="$CHALK_DEV_SYNC_PORT"
  export CHALK_POSTGRES_PORT="$CHALK_DEV_POSTGRES_PORT" CHALK_REDIS_PORT="$CHALK_DEV_REDIS_PORT"
  export CHALK_DEV_API_ORIGIN="http://127.0.0.1:${CHALK_DEV_API_PORT}" VITE_ORIGIN="http://127.0.0.1:${CHALK_DEV_WEB_PORT}"
  export CHALK_DEV_STATE_ROOT="${TMPDIR}/chalk-dev-state"
  slot_owner="${CHALK_REMOTE_JOB_TOKEN:-$$}"
  export CHALK_REDIS_CONTAINER="chalk-slot-${CHALK_REMOTE_SLOT}-${slot_owner}" CHALK_REDIS_VOLUME="chalk-slot-${CHALK_REMOTE_SLOT}-${slot_owner}"
  export CHALK_POSTGRES_CONTAINER="chalk-postgres-slot-${CHALK_REMOTE_SLOT}-${slot_owner}" CHALK_POSTGRES_VOLUME="chalk-postgres-slot-${CHALK_REMOTE_SLOT}-${slot_owner}"
  if [[ -n "${CHALK_REMOTE_RESOURCE_DIR:-}" ]]; then
    mkdir -p "$CHALK_REMOTE_RESOURCE_DIR"
    printf '%s\n' "$CHALK_REMOTE_SLOT" > "$CHALK_REMOTE_RESOURCE_DIR/slot"
  fi
  unset slot_owner
  unset slot_base
fi
