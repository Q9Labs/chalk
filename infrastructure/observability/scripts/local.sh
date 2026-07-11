#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/../../.." && pwd)"
compose_file="${root}/infrastructure/observability/compose.yaml"
command_name="${1:-start}"

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
    docker compose -f "${compose_file}" up -d
    wait_for_stack
    echo "Grafana: http://127.0.0.1:3000/d/chalk-observability-v1/chalk-observability"
    echo "OTLP HTTP: http://127.0.0.1:4318"
    echo "OTLP gRPC: http://127.0.0.1:4317"
    ;;
  stop)
    docker compose -f "${compose_file}" down
    ;;
  reset)
    docker compose -f "${compose_file}" down --volumes
    ;;
  status)
    docker compose -f "${compose_file}" ps
    ;;
  logs)
    docker compose -f "${compose_file}" logs --follow --tail 200
    ;;
  smoke)
    wait_for_stack
    node "${root}/infrastructure/observability/scripts/smoke.mjs"
    ;;
  e2e)
    bash "${root}/infrastructure/observability/scripts/e2e.sh"
    ;;
  *)
    echo "Usage: $0 {start|stop|reset|status|logs|smoke|e2e}" >&2
    exit 2
    ;;
esac
