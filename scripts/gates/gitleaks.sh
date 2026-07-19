#!/usr/bin/env bash
set -euo pipefail

CONFIG_PATH=".gitleaks.toml"
BASE_REF="${GITLEAKS_BASE_REF:-origin/master}"
LOG_OPTS="${GITLEAKS_LOG_OPTS:-}"

if [[ -z "${LOG_OPTS}" ]] && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git rev-parse --verify --quiet "${BASE_REF}" >/dev/null; then
    MERGE_BASE="$(git merge-base "${BASE_REF}" HEAD || true)"
    if [[ -n "${MERGE_BASE}" ]] && [[ "$(git rev-list --count "${MERGE_BASE}..HEAD")" != "0" ]]; then
      LOG_OPTS="${MERGE_BASE}..HEAD"
    fi
  fi

  if [[ -z "${LOG_OPTS}" ]]; then
    LOG_OPTS="-1 HEAD"
  fi
fi

run_gitleaks() {
  if [[ "${GATE_SCOPE:-}" == "staged" ]]; then
    "$@" protect --staged --config "${CONFIG_PATH}" --redact --verbose
    return
  fi

  if [[ -n "${LOG_OPTS}" ]]; then
    "$@" git . --log-opts "${LOG_OPTS}" --config "${CONFIG_PATH}" --redact --verbose
  else
    "$@" git . --config "${CONFIG_PATH}" --redact --verbose --timeout 120
  fi
}

if command -v gitleaks >/dev/null 2>&1; then
  run_gitleaks gitleaks
  exit $?
fi

if command -v go >/dev/null 2>&1; then
  run_gitleaks go run github.com/zricethezav/gitleaks/v8@v8.30.1
  exit $?
fi

echo "Gitleaks is required. Install gitleaks or Go, then rerun pnpm run security:secrets." >&2
exit 127
