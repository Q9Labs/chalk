#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null 2>&1 && [[ -x "${HOME}/.orbstack/bin/docker" ]]; then
  export PATH="${HOME}/.orbstack/bin:${PATH}"
fi

root="$(cd "$(dirname "$0")/../../.." && pwd)"
compose_file="${root}/infrastructure/observability/compose.yaml"
command_name="${1:-start}"
ledger_target="${CHALK_OBSERVABILITY_LEDGER_TARGET:-observability}"

configure_ledger_datasource() {
  case "${ledger_target}" in
    api)
      export CHALK_GRAFANA_LEDGER_DATABASE="${CHALK_GRAFANA_LEDGER_DATABASE:-chalk}"
      export CHALK_GRAFANA_LEDGER_PASSWORD="${CHALK_GRAFANA_LEDGER_PASSWORD:-postgres}"
      export CHALK_GRAFANA_LEDGER_URL="${CHALK_GRAFANA_LEDGER_URL:-host.docker.internal:5432}"
      export CHALK_GRAFANA_LEDGER_USER="${CHALK_GRAFANA_LEDGER_USER:-postgres}"
      ;;
    observability)
      export CHALK_GRAFANA_LEDGER_DATABASE="${CHALK_GRAFANA_LEDGER_DATABASE:-chalk_observability}"
      export CHALK_GRAFANA_LEDGER_PASSWORD="${CHALK_GRAFANA_LEDGER_PASSWORD:-postgres}"
      export CHALK_GRAFANA_LEDGER_URL="${CHALK_GRAFANA_LEDGER_URL:-postgres:5432}"
      export CHALK_GRAFANA_LEDGER_USER="${CHALK_GRAFANA_LEDGER_USER:-postgres}"
      ;;
    *)
      echo "CHALK_OBSERVABILITY_LEDGER_TARGET must be api or observability (got ${ledger_target})." >&2
      exit 2
      ;;
  esac
}

wait_for_stack() {
  for _ in {1..90}; do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1 && \
      curl -fsS http://127.0.0.1:13133/ready >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done

  echo "Chalk observability stack did not become ready." >&2
  docker compose -f "${compose_file}" ps >&2
  docker compose -f "${compose_file}" logs --tail 200 >&2
  return 1
}

case "${command_name}" in
  start)
    configure_ledger_datasource
    docker compose -f "${compose_file}" up -d
    wait_for_stack
    echo "Grafana: http://127.0.0.1:3000/d/chalk-observability-v1/chalk-observability"
    echo "Grafana journey ledger: ${CHALK_GRAFANA_LEDGER_DATABASE}@${CHALK_GRAFANA_LEDGER_URL}"
    echo "OTLP HTTP: http://127.0.0.1:4318"
    echo "OTLP gRPC: http://127.0.0.1:4317"
    ;;
  stop)
    configure_ledger_datasource
    docker compose -f "${compose_file}" down
    ;;
  reset)
    configure_ledger_datasource
    docker compose -f "${compose_file}" down --volumes
    ;;
  status)
    configure_ledger_datasource
    docker compose -f "${compose_file}" ps
    ;;
  logs)
    configure_ledger_datasource
    docker compose -f "${compose_file}" logs --follow --tail 200
    ;;
  smoke)
    configure_ledger_datasource
    wait_for_stack
    node "${root}/infrastructure/observability/scripts/smoke.mjs"
    ;;
  e2e)
    bash "${root}/infrastructure/observability/scripts/e2e.sh"
    ;;
  webhook-canary)
    node "${root}/infrastructure/observability/scripts/webhook-canary.mjs"
    ;;
  *)
    echo "Usage: $0 {start|stop|reset|status|logs|smoke|e2e|webhook-canary}" >&2
    exit 2
    ;;
esac
