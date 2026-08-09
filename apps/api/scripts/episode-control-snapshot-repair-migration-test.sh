#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${repository_root}/apps/api"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

if [[ "${CHALK_EPISODE_SNAPSHOT_REPAIR_PROOF_CHILD:-0}" != "1" ]]; then
  export CHALK_GATE_POSTGRES_MIGRATION_TARGET=20260809160000
  for proof_case in valid unsupported_snapshot unsupported_intent; do
    CHALK_EPISODE_SNAPSHOT_REPAIR_PROOF_CHILD=1 \
      CHALK_EPISODE_SNAPSHOT_REPAIR_PROOF_CASE="${proof_case}" \
      "${repository_root}/scripts/gates/with-postgres.sh" -- \
      "${repository_root}/apps/api/scripts/episode-control-snapshot-repair-migration-test.sh" "$@"
  done
  exit 0
fi

database_url="${CHALK_DATABASE_URL:?with-postgres.sh did not provide CHALK_DATABASE_URL}"
proof_case="${CHALK_EPISODE_SNAPSHOT_REPAIR_PROOF_CASE:-valid}"
goose() { go tool goose -dir db/migrations postgres "${database_url}" "$@"; }
psql() { command psql "${database_url}" -v ON_ERROR_STOP=1 "$@"; }

tenant_id='00000000-0000-4000-8000-000000000021'
space_id='00000000-0000-4000-8000-000000000022'
episode_id='00000000-0000-4000-8000-000000000023'
participant_id='00000000-0000-4000-8000-000000000024'
intent_id='00000000-0000-4000-8000-000000000025'
deadline='2026-08-09T12:34:56.789Z'
deadline_ms='1786278896789'

psql <<'SQL'
create function fixture_episode_snapshot_canonical_json(value jsonb)
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
                    to_jsonb(entry.key)::text || ':' || fixture_episode_snapshot_canonical_json(entry.value),
                    ',' order by entry.key
                ),
                ''
            ) || '}'
            into encoded
            from jsonb_each(value) entry;
            return encoded;
        when 'array' then
            select '[' || coalesce(
                string_agg(fixture_episode_snapshot_canonical_json(entry.value), ',' order by entry.ordinality),
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
SQL

psql <<SQL
insert into tenants (id, name)
values ('${tenant_id}', 'episode-snapshot-repair-proof');

insert into spaces (id, name, tenant_id, slug, media_plane)
values ('${space_id}', 'Episode Snapshot Repair Proof', '${tenant_id}', 'episode-snapshot-repair-proof', 'cf_sfu');

insert into episodes (
    id, status, space_id, tenant_id, started_at, deadline_at, config_snapshot
)
values (
    '${episode_id}', 'active', '${space_id}', '${tenant_id}',
    '${deadline}'::timestamptz - interval '1 hour', '${deadline}'::timestamptz,
    '{
      "roles": {
        "facilitator": ["publishAudio", "publishVideo", "subscribe", "raiseHand", "sendChat"],
        "observer": ["subscribe", "sendReaction"]
      },
      "admission_policy": {"mode": "knock"},
      "default_episode_duration_seconds": 3600,
      "maximum_episode_duration_seconds": 7200,
      "linger_window_seconds": 30
    }'::jsonb
);

insert into sync_episode_control (
    tenant_id, space_id, episode_id, control_revision, folded_state,
    state_schema_version, state_digest, snapshot_bytes,
    lifecycle_intent_count, lifecycle_intent_bytes
)
values (
    '${tenant_id}', '${space_id}', '${episode_id}', 0,
    jsonb_build_object(
        'admission_policy', jsonb_build_object('mode', 'knock'),
        'admission_requests', '[]'::jsonb,
        'config_snapshot', '{
          "roles": {
            "facilitator": ["publishAudio", "publishVideo", "subscribe", "raiseHand", "sendChat"],
            "observer": ["subscribe", "sendReaction"]
          },
          "admission_policy": {"mode": "knock"},
          "default_episode_duration_seconds": 3600,
          "maximum_episode_duration_seconds": 7200,
          "linger_window_seconds": 30
        }'::jsonb,
        'control_revision', 0,
        'participants', '[]'::jsonb,
        'recording', null,
        'state_schema_version', 1,
        'status', 'active'
    ),
    1, decode(repeat('aa', 32), 'hex'), 1, 1, 2
);

insert into participants (
    id, name, capabilities, tenant_id, space_id, episode_id,
    generation, status, role
)
values (
    '${participant_id}', 'Ada',
    array['publishAudio', 'publishVideo', 'subscribe', 'raiseHand', 'sendChat']::text[],
    '${tenant_id}', '${space_id}', '${episode_id}', 1, 'joining', 'facilitator'
);

insert into sync_lifecycle_intents (
    tenant_id, space_id, episode_id, lifecycle_intent_id, request_key,
    request_fingerprint, intent_name, participant_id, participant_generation,
    payload, status, attempt_count, last_error_code
)
values (
    '${tenant_id}', '${space_id}', '${episode_id}', '${intent_id}',
    'episode-snapshot-repair-proof-001', decode(repeat('bb', 32), 'hex'),
    'participant_joined', '${participant_id}', 1,
    '{"display_name":"Ada","participant_id":"${participant_id}","role":"facilitator"}'::jsonb,
    'pending', 2, 'invalid_state'
);
SQL

if [[ "${proof_case}" == "unsupported_snapshot" || "${proof_case}" == "unsupported_intent" ]]; then
  if [[ "${proof_case}" == "unsupported_snapshot" ]]; then
    psql -c "update sync_episode_control set folded_state = folded_state || '{\"future_authority\":true}'::jsonb where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'"
    expected_error="unsupported revision-zero snapshot"
  else
    psql -c "update sync_lifecycle_intents set payload = payload || '{\"future_field\":true}'::jsonb where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'"
    expected_error="unsupported participant_joined intent"
  fi
  set +e
  migration_output="$(goose up 2>&1)"
  migration_status=$?
  set -e
  if [[ "${migration_status}" -eq 0 ]]; then
    echo "Expected unsupported revision-zero snapshot to abort the repair migration." >&2
    exit 1
  fi
  if [[ "${migration_output}" != *"${expected_error}"* ]]; then
    echo "Unsupported snapshot failed without the repair preflight error:" >&2
    echo "${migration_output}" >&2
    exit 1
  fi
  if [[ "${proof_case}" == "unsupported_snapshot" ]]; then
    unchanged="$(psql -At -c "select folded_state ? 'future_authority' from sync_episode_control where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'")"
  else
    unchanged="$(psql -At -c "select payload ? 'future_field' from sync_lifecycle_intents where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'")"
  fi
  if [[ "${unchanged}" != "t" ]]; then
    echo "Unsupported input was changed after the failed migration." >&2
    exit 1
  fi
  echo "episode control snapshot repair ${proof_case} proof passed"
  exit 0
fi

goose up >/dev/null

psql <<SQL
do \$\$
declare
    state jsonb;
    expected jsonb := jsonb_build_object(
        'admission_policy', 'knock',
        'admission_requests', '[]'::jsonb,
        'control_revision', 0,
        'deadline_at_ms', ${deadline_ms},
        'deadline_generation', 1,
        'participants', '[]'::jsonb,
        'recording', null,
        'role_capabilities', jsonb_build_object(
            'facilitator', jsonb_build_array('publishAudio', 'publishVideo', 'subscribe', 'raiseHand', 'sendChat'),
            'observer', jsonb_build_array('subscribe', 'sendReaction')
        ),
        'state_schema_version', 1,
        'status', 'active'
    );
    digest bytea;
begin
    select folded_state into state
    from sync_episode_control
    where tenant_id = '${tenant_id}' and episode_id = '${episode_id}';
    if state <> expected then
        raise exception 'repaired folded_state differs from Sync v1 fixture';
    end if;
    digest := sha256(convert_to('chalk-sync-state-v1', 'UTF8') || int4send(1) || convert_to(fixture_episode_snapshot_canonical_json(expected), 'UTF8'));
    if (select state_digest from sync_episode_control where tenant_id = '${tenant_id}' and episode_id = '${episode_id}') <> digest then
        raise exception 'repaired state_digest does not match the Sync digest formula';
    end if;
    if (select snapshot_bytes from sync_episode_control where tenant_id = '${tenant_id}' and episode_id = '${episode_id}') <> octet_length(
        fixture_episode_snapshot_canonical_json(expected || jsonb_build_object('state_digest', encode(digest, 'hex')))
    ) then
        raise exception 'repaired snapshot_bytes does not match the Sync wire formula';
    end if;
    if (select last_error_code from sync_lifecycle_intents where lifecycle_intent_id = '${intent_id}') is not null then
        raise exception 'pending invalid_state intent was not made runnable';
    end if;
end;
\$\$;
SQL

set +e
down_output="$(goose down 2>&1)"
down_status=$?
set -e
if [[ "${down_status}" -eq 0 ]]; then
  echo "Expected the canonical snapshot repair migration Down to refuse rollback." >&2
  exit 1
fi
if [[ "${down_output}" != *"canonical control integrity cannot return"* ]]; then
  echo "Irreversible Down failed without the repair guard:" >&2
  echo "${down_output}" >&2
  exit 1
fi

echo "episode control snapshot repair valid-shape proof passed"
