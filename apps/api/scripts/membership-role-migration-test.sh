#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${repository_root}/apps/api"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

if [[ "${CHALK_MEMBERSHIP_ROLE_MIGRATION_PROOF_CHILD:-0}" != "1" ]]; then
  export CHALK_GATE_POSTGRES_MIGRATION_TARGET=20260805030000
  export CHALK_MEMBERSHIP_ROLE_MIGRATION_PROOF_CHILD=1
  exec "${repository_root}/scripts/gates/with-postgres.sh" -- "${repository_root}/apps/api/scripts/membership-role-migration-test.sh" "$@"
fi

database_url="${CHALK_DATABASE_URL:?with-postgres.sh did not provide CHALK_DATABASE_URL}"
goose() { go tool goose -dir db/migrations postgres "${database_url}" "$@"; }
psql() { command psql "${database_url}" -v ON_ERROR_STOP=1 "$@"; }

goose up-to 20260805030000 >/dev/null
psql -c "insert into tenants (id, name) values ('00000000-0000-4000-8000-000000000001', 'migration-proof');"
psql -c "insert into users (id, name, email) values
  ('00000000-0000-4000-8000-000000000011', 'admin', 'admin@migration-proof.test'),
  ('00000000-0000-4000-8000-000000000012', 'member', 'member@migration-proof.test'),
  ('00000000-0000-4000-8000-000000000013', 'viewer', 'viewer@migration-proof.test');"
psql -c "insert into memberships (id, tenant_id, user_id, role) values
  ('00000000-0000-4000-8000-000000000021', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000011', 'admin'),
  ('00000000-0000-4000-8000-000000000022', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000012', 'member'),
  ('00000000-0000-4000-8000-000000000023', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000013', 'viewer');"

goose up-to 20260805040000 >/dev/null
canonical_roles="$(psql -At -c "select string_agg(role, ',' order by role, id) from memberships;")"
if [[ "${canonical_roles}" != "collaborator,collaborator,observer" ]]; then
  echo "Unexpected canonical roles after migration: ${canonical_roles}" >&2
  exit 1
fi

set +e
rollback_output="$(goose down 2>&1)"
rollback_status=$?
set -e
if [[ "${rollback_status}" -eq 0 ]]; then
  echo "Expected the irreversible role migration rollback to fail." >&2
  exit 1
fi
if [[ "${rollback_output}" != *"membership role vocabulary migration is irreversible"* ]]; then
  echo "Rollback failed without the deliberate irreversibility error:" >&2
  echo "${rollback_output}" >&2
  exit 1
fi

version="$(psql -At -c "select version_id from goose_db_version order by id desc limit 1;")"
if [[ "${version}" != "20260805040000" ]]; then
  echo "Goose version changed after failed rollback: ${version}" >&2
  exit 1
fi
canonical_roles_after_failure="$(psql -At -c "select string_agg(role, ',' order by role, id) from memberships;")"
if [[ "${canonical_roles_after_failure}" != "${canonical_roles}" ]]; then
  echo "Canonical role rows changed after failed rollback: ${canonical_roles_after_failure}" >&2
  exit 1
fi

echo "Membership role migration proof passed: Up mapped legacy roles; Down failed deliberately; Goose remained at ${version}."
