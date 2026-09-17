#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${repository_root}/apps/api"
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

if [[ "${CHALK_RECORDING_RELEASE_PROOF_CHILD:-0}" != "1" ]]; then
  CHALK_GATE_POSTGRES_MIGRATION_TARGET=20260820100000 \
    CHALK_RECORDING_RELEASE_PROOF_CHILD=1 \
    "${repository_root}/scripts/gates/with-postgres.sh" -- bash "$0" "$@"
  exit 0
fi

database_url="${CHALK_DATABASE_URL:?isolated PostgreSQL helper must supply a database}"
proof_root="$(mktemp -d "${TMPDIR:-/tmp}/chalk-recording-migration.XXXXXX")"
trap 'rm -rf "${proof_root}"' EXIT
mkdir "${proof_root}/baseline"

# Reproduce the applied pre-recording migration set, including later unrelated work.
for migration in db/migrations/*.sql; do
  version="${migration##*/}"
  version="${version%%_*}"
  if [[ "${version}" -le 20260820100000 || "${version}" == 20260827120000 || "${version}" == 20260829160000 || "${version}" == 20260829170000 || "${version}" == 20260830000000 ]]; then
    cp "${migration}" "${proof_root}/baseline/"
  fi
done
go tool goose -dir "${proof_root}/baseline" postgres "${database_url}" up-to 20260830000000
psql "${database_url}" -X -v ON_ERROR_STOP=1 -c "INSERT INTO tenants(id, name) VALUES ('00000000-0000-4000-8000-000000000071', 'recording-upgrade-proof')"
printf '%s' "${database_url}" > "${proof_root}/database-url"
chmod 600 "${proof_root}/database-url"
go build -o "${proof_root}/chalk-migrate" ./cmd/migrate

latest_migration="$(find db/migrations -name '*.sql' -exec basename {} \; | sort | tail -1)"
target="${latest_migration%%_*}"
base_args=(--database-url-file "${proof_root}/database-url" --target "${target}")

if "${proof_root}/chalk-migrate" "${base_args[@]}" --allow-missing-version 20260819120000 > "${proof_root}/old-contract.log" 2>&1; then
  echo "old deployment contract unexpectedly accepted missing recording migrations" >&2
  exit 1
fi
if ! grep -Fq 'unallowlisted out-of-order migration versions: 20260823010000,20260825010000,20260825015000,20260825020000,20260825030000,20260825040000,20260825050000,20260825060000,20260825070000' "${proof_root}/old-contract.log"; then
  cat "${proof_root}/old-contract.log" >&2
  exit 1
fi

read -r -a repair_args <<< "$(sed -n 's/^Exec=--database-url-file \/run\/chalk\/migrate\/database-url --target __DATABASE_MIGRATION_TARGET__ //p' "${repository_root}/infrastructure/managed-episode/quadlet/chalk-api-migrate.container.in")"
"${proof_root}/chalk-migrate" "${base_args[@]}" "${repair_args[@]}"
"${proof_root}/chalk-migrate" "${base_args[@]}" "${repair_args[@]}"
[[ "$(psql "${database_url}" -X -Atc 'SELECT max(version_id) FROM goose_db_version WHERE is_applied')" == "${target}" ]]
[[ "$(psql "${database_url}" -X -Atc "SELECT count(*) FROM tenants WHERE id = '00000000-0000-4000-8000-000000000071'")" == 1 ]]

# The bounded recording repair must not silently accept an unrelated history gap.
psql "${database_url}" -X -v ON_ERROR_STOP=1 -c 'DELETE FROM goose_db_version WHERE version_id = 20260827120000'
if "${proof_root}/chalk-migrate" "${base_args[@]}" "${repair_args[@]}" > "${proof_root}/unrelated-gap.log" 2>&1; then
  echo "recording repair unexpectedly accepted an unrelated missing migration" >&2
  exit 1
fi
grep -Fq 'unallowlisted out-of-order migration versions: 20260827120000' "${proof_root}/unrelated-gap.log"
echo "recording release upgrade, repeat application, data preservation, and unrelated-gap rejection passed"
