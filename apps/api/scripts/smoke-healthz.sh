#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi

addr="${CHALK_API_SMOKE_ADDR:-127.0.0.1:18080}"
base_url="http://${addr}"
tmpdir="$(mktemp -d)"
server_log="${tmpdir}/server.log"
body_file="${tmpdir}/body.json"
headers_file="${tmpdir}/headers.txt"
server_pid=""

cleanup() {
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
  rm -rf "${tmpdir}"
}

trap cleanup EXIT

echo "Starting Chalk API on ${addr}..."
CHALK_API_ADDR="${addr}" GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}" go run ./cmd >"${server_log}" 2>&1 &
server_pid="$!"

status=""
for _ in {1..60}; do
  if ! kill -0 "${server_pid}" 2>/dev/null; then
    echo "API process exited before /healthz was reachable."
    echo
    cat "${server_log}"
    exit 1
  fi

  status="$(curl -sS -o "${body_file}" -w "%{http_code}" "${base_url}/healthz" 2>/dev/null || true)"
  if [[ "${status}" == "200" ]]; then
    break
  fi
  sleep 0.1
done

if [[ "${status}" != "200" ]]; then
  echo "Expected GET /healthz to return 200, got ${status:-no response}."
  echo
  cat "${server_log}"
  exit 1
fi

curl -sS -D "${headers_file}" -o "${body_file}" "${base_url}/healthz" >/dev/null

if ! grep -qi '^content-type: application/json' "${headers_file}"; then
  echo "Expected Content-Type to start with application/json."
  echo
  cat "${headers_file}"
  exit 1
fi

node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.status !== "ok") {
  console.error(`Expected JSON status to be "ok", got ${JSON.stringify(data.status)}`);
  process.exit(1);
}
' "${body_file}"

ready_status="$(curl -sS -o "${body_file}" -w "%{http_code}" "${base_url}/readyz" 2>/dev/null || true)"
if [[ "${ready_status}" != "200" ]]; then
  echo "Expected GET /readyz to return 200, got ${ready_status:-no response}."
  echo
  cat "${server_log}"
  exit 1
fi

node -e '
const fs = require("node:fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (data.status !== "ok") {
  console.error(`Expected readyz JSON status to be "ok", got ${JSON.stringify(data.status)}`);
  process.exit(1);
}
if (!data.dependencies || data.dependencies.postgres !== "ok") {
  console.error(`Expected readyz JSON dependencies.postgres to be "ok", got ${JSON.stringify(data.dependencies)}`);
  process.exit(1);
}
' "${body_file}"

not_found_status="$(curl -sS -o /dev/null -w "%{http_code}" "${base_url}/not-found" 2>/dev/null || true)"
if [[ "${not_found_status}" != "404" ]]; then
  echo "Expected unknown route to return 404, got ${not_found_status:-no response}."
  exit 1
fi

method_status="$(curl -sS -X POST -o /dev/null -w "%{http_code}" "${base_url}/healthz" 2>/dev/null || true)"
if [[ "${method_status}" != "405" ]]; then
  echo "Expected POST /healthz to return 405, got ${method_status:-no response}."
  exit 1
fi

echo "Operational smoke test passed."
