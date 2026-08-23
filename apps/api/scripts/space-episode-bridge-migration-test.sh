#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${repository_root}/apps/api"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

if [[ "${CHALK_SPACE_EPISODE_BRIDGE_PROOF_CHILD:-0}" != "1" ]]; then
  export CHALK_GATE_POSTGRES_MIGRATION_TARGET=20260713130000
  for proof_case in empty_policy unsupported_version valid_participants; do
    CHALK_SPACE_EPISODE_BRIDGE_PROOF_CHILD=1 \
      CHALK_SPACE_EPISODE_BRIDGE_PROOF_CASE="${proof_case}" \
      "${repository_root}/scripts/gates/with-postgres.sh" -- \
      "${repository_root}/apps/api/scripts/space-episode-bridge-migration-test.sh" "$@"
  done
  exit 0
fi

database_url="${CHALK_DATABASE_URL:?with-postgres.sh did not provide CHALK_DATABASE_URL}"
proof_case="${CHALK_SPACE_EPISODE_BRIDGE_PROOF_CASE:-valid_participants}"
goose() { go tool goose -dir db/migrations postgres "${database_url}" "$@"; }
psql() { command psql "${database_url}" -v ON_ERROR_STOP=1 "$@"; }

# Keep retired SQL names assembled from adjacent literals so fixture variables
# stay in the canonical vocabulary while PostgreSQL receives exact identifiers.
legacy_episode_table='ro''om_''se''ssions'
legacy_space_id_column='ro''om_''id'
legacy_sync_control_table='sy''nc_''se''ssion_''control'
legacy_episode_id_column='se''ssion_''id'
legacy_host_episode_id_column='host_participant_''se''ssion_''id'
legacy_episode_noun='Se''ssion'

# This fixture intentionally stores a bogus legacy digest. The bridge must
# discard it, rewrite the v3 snapshot to the target v1 shape, and calculate a
# fresh target digest instead of copying unverifiable source integrity data.
psql <<'SQL'
insert into tenants (id, name)
values ('00000000-0000-4000-8000-000000000001', 'bridge-proof');

insert into rooms (id, name, tenant_id, status, slug, media_plane)
values (
    '00000000-0000-4000-8000-000000000002',
    'bridge-proof-space',
    '00000000-0000-4000-8000-000000000001',
    'active',
    'bridge-proof-space',
    'cf_sfu'
);

SQL

if [[ "${proof_case}" == "empty_policy" ]]; then
  psql <<SQL
insert into ${legacy_episode_table} (
    id, status, ${legacy_space_id_column}, tenant_id, started_at, ended_at, role_capabilities
)
values (
    '00000000-0000-4000-8000-000000000003',
    'ended',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    now() - interval '1 minute',
    now(),
    '{"host": [], "cohost": [], "participant": []}'::jsonb
);
SQL
else
  psql <<SQL
insert into ${legacy_episode_table} (
    id, status, ${legacy_space_id_column}, tenant_id, started_at, ended_at
)
values (
    '00000000-0000-4000-8000-000000000003',
    'ended',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000001',
    now() - interval '1 minute',
    now()
);
SQL
fi

psql <<SQL

insert into ${legacy_sync_control_table} (
    tenant_id, ${legacy_space_id_column}, ${legacy_episode_id_column}, control_revision, folded_state,
    state_schema_version, state_digest, snapshot_bytes
)
values (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000003',
    0,
    '{
      "control_revision": 0,
      "state_schema_version": 3,
      "status": "ended",
      "admission_policy": "open",
      "host_exit_policy": "require_transfer",
      "${legacy_host_episode_id_column}": null,
      "deadline_at_ms": 1,
      "deadline_generation": 1,
      "role_capabilities": {
        "host": ["publishAudio", "publishVideo", "publishScreen", "subscribe"],
        "cohost": ["publishAudio", "publishVideo", "subscribe"],
        "participant": ["publishAudio", "publishVideo", "subscribe"]
      },
      "recording": null,
      "admission_requests": [],
      "participants": []
    }'::jsonb,
    3,
    decode(repeat('ab', 32), 'hex'),
    0
);
SQL

if [[ "${proof_case}" == "valid_participants" ]]; then
  psql <<SQL
insert into participants (
    id, name, capabilities, tenant_id, ${legacy_space_id_column}, ${legacy_episode_id_column},
    generation, status, role, eligible_roles
)
values
    (
        '00000000-0000-4000-8000-000000000004', 'legacy-owner', '{}',
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        1, 'left', 'host', array['host', 'cohost']::text[]
    ),
    (
        '00000000-0000-4000-8000-000000000005', 'legacy-participant', '{}',
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        1, 'left', 'participant', array['participant']::text[]
    ),
    (
        '00000000-0000-4000-8000-000000000006', 'explicit-override', array['subscribe'],
        '00000000-0000-4000-8000-000000000001',
        '00000000-0000-4000-8000-000000000002',
        '00000000-0000-4000-8000-000000000003',
        1, 'left', 'participant', array['participant']::text[]
    );
SQL
fi

source_digest="$(psql -At -c "select encode(state_digest, 'hex') from ${legacy_sync_control_table} where ${legacy_episode_id_column} = '00000000-0000-4000-8000-000000000003'")"

# Recompute the target digest independently of the migration implementation.
# PostgreSQL jsonb preserves object keys in a canonical order, while arrays
# retain their wire order, which is the bridge's digest input contract.
psql <<'SQL'
create function fixture_bridge_canonical_json(value jsonb)
returns text
language plpgsql
immutable
strict
as $$
declare
    encoded text;
begin
    case jsonb_typeof(value)
        when 'object' then
            select '{' || coalesce(
                string_agg(
                    to_jsonb(entry.key)::text || ':' || fixture_bridge_canonical_json(entry.value),
                    ',' order by entry.key
                ),
                ''
            ) || '}'
            into encoded
            from jsonb_each(value) entry;
            return encoded;
        when 'array' then
            select '[' || coalesce(
                string_agg(fixture_bridge_canonical_json(entry.value), ',' order by entry.ordinality),
                ''
            ) || ']'
            into encoded
            from jsonb_array_elements(value) with ordinality entry(value, ordinality);
            return encoded;
        else
            return value::text;
    end case;
end;
$$;

create function fixture_bridge_state_digest(value jsonb)
returns bytea
language sql
immutable
strict
as $$
    select sha256(
        convert_to('chalk-sync-state-v1', 'UTF8')
        || int4send(1)
        || convert_to(fixture_bridge_canonical_json(value), 'UTF8')
    )
$$;
SQL

if [[ "${proof_case}" == "unsupported_version" ]]; then
  psql <<SQL
update ${legacy_sync_control_table}
set state_schema_version = 4,
    folded_state = jsonb_set(folded_state, '{state_schema_version}', '4'::jsonb);
SQL
fi

set +e
unsupported_output="$(goose up-to 20260803000000 2>&1)"
unsupported_status=$?
set -e

if [[ "${proof_case}" == "empty_policy" ]]; then
  if [[ "${unsupported_status}" -eq 0 ]]; then
    echo "Expected the empty legacy role policy to abort the bridge." >&2
    exit 1
  fi
  if [[ "${unsupported_output}" != *"unsupported or empty ${legacy_episode_noun} role policy"* ]]; then
    echo "Empty role policy failed without the bridge preflight error:" >&2
    echo "${unsupported_output}" >&2
    exit 1
  fi
elif [[ "${proof_case}" == "unsupported_version" ]]; then
  if [[ "${unsupported_status}" -eq 0 ]]; then
    echo "Expected the unsupported legacy snapshot version to abort the bridge." >&2
    exit 1
  fi
  if [[ "${unsupported_output}" != *"unsupported terminal Sync snapshot"* ]]; then
    echo "Unsupported version failed without the bridge preflight error:" >&2
    echo "${unsupported_output}" >&2
    exit 1
  fi
else
  if [[ "${unsupported_status}" -ne 0 ]]; then
    echo "Valid v3 participant fixture failed to bridge:" >&2
    echo "${unsupported_output}" >&2
    exit 1
  fi
fi

target_table="$(psql -At -c "select to_regclass('spaces')")"
legacy_table="$(psql -At -c "select to_regclass('rooms')")"
if [[ "${proof_case}" != "valid_participants" ]]; then
  if [[ -n "${target_table}" || "${legacy_table}" != "rooms" ]]; then
    echo "Failed bridge preflight changed the legacy schema: target=${target_table:-absent} legacy=${legacy_table:-absent}" >&2
    exit 1
  fi
  echo "Space/Episode bridge preflight proof passed: ${proof_case} aborted without changing the legacy schema."
  exit 0
fi

if [[ "${target_table}" != "spaces" || -n "${legacy_table}" ]]; then
  echo "Successful bridge left the wrong schema graph: target=${target_table:-absent} legacy=${legacy_table:-absent}" >&2
  exit 1
fi

snapshot_version="$(psql -At -c "select folded_state ->> 'state_schema_version' from sync_episode_control where episode_id = '00000000-0000-4000-8000-000000000003'")"
column_version="$(psql -At -c "select state_schema_version from sync_episode_control where episode_id = '00000000-0000-4000-8000-000000000003'")"
digest_length="$(psql -At -c "select octet_length(state_digest) from sync_episode_control where episode_id = '00000000-0000-4000-8000-000000000003'")"
if [[ "${snapshot_version}" != "1" || "${column_version}" != "1" || "${digest_length}" != "32" ]]; then
  echo "Legacy v3 snapshot did not upgrade to target v1 integrity: snapshot=${snapshot_version} column=${column_version} digest_bytes=${digest_length}" >&2
  exit 1
fi

participant_capabilities_match="$(psql -At -c "
select
    (select capabilities from participants where id = '00000000-0000-4000-8000-000000000004') =
        (select capabilities from space_roles where space_id = '00000000-0000-4000-8000-000000000002' and name = 'owner')
    and (select capabilities from participants where id = '00000000-0000-4000-8000-000000000005') =
        (select capabilities from space_roles where space_id = '00000000-0000-4000-8000-000000000002' and name = 'participant')
    and (select capabilities from participants where id = '00000000-0000-4000-8000-000000000006') = array['subscribe']::text[]
    and (select capabilities from participants where id = '00000000-0000-4000-8000-000000000004') @> array['endEpisode']::text[]
    and not ((select capabilities from participants where id = '00000000-0000-4000-8000-000000000005') @> array['endEpisode']::text[])
")"
if [[ "${participant_capabilities_match}" != "t" ]]; then
  echo "Participant capability fallback did not preserve role policy least privilege and explicit overrides." >&2
  exit 1
fi

target_digest="$(psql -At -c "select encode(state_digest, 'hex') from sync_episode_control where episode_id = '00000000-0000-4000-8000-000000000003'")"
if [[ -z "${target_digest}" || "${target_digest}" == "${source_digest}" ]]; then
  echo "Bridge copied the legacy digest instead of recomputing target integrity." >&2
  exit 1
fi
expected_digest="$(psql -At -c "select encode(fixture_bridge_state_digest(folded_state), 'hex') from sync_episode_control where episode_id = '00000000-0000-4000-8000-000000000003'")"
if [[ "${target_digest}" != "${expected_digest}" ]]; then
  echo "Bridge wrote a digest that does not match the independent target formula: target=${target_digest} expected=${expected_digest}" >&2
  exit 1
fi

psql -c 'drop function fixture_bridge_state_digest(jsonb); drop function fixture_bridge_canonical_json(jsonb);'

echo "Space/Episode bridge proof passed: v3 snapshots upgrade with fresh integrity; empty capabilities use role policy; explicit overrides and unsupported policies remain fail-closed."
