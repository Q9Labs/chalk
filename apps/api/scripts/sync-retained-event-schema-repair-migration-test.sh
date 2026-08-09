#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "${repository_root}/apps/api"
if [[ -d /usr/local/go/bin ]]; then
  export PATH="/usr/local/go/bin:${PATH}"
fi
export GOTOOLCHAIN="${CHALK_API_GOTOOLCHAIN:-go1.25.11+auto}"

if [[ "${CHALK_SYNC_RETAINED_EVENT_REPAIR_PROOF_CHILD:-0}" != "1" ]]; then
  export CHALK_GATE_POSTGRES_MIGRATION_TARGET=20260808150000
  for proof_case in valid unsupported_payload; do
    CHALK_SYNC_RETAINED_EVENT_REPAIR_PROOF_CHILD=1 \
      CHALK_SYNC_RETAINED_EVENT_REPAIR_PROOF_CASE="${proof_case}" \
      "${repository_root}/scripts/gates/with-postgres.sh" -- \
      "${repository_root}/apps/api/scripts/sync-retained-event-schema-repair-migration-test.sh" "$@"
  done
  exit 0
fi

database_url="${CHALK_DATABASE_URL:?with-postgres.sh did not provide CHALK_DATABASE_URL}"
proof_case="${CHALK_SYNC_RETAINED_EVENT_REPAIR_PROOF_CASE:-valid}"
goose() { go tool goose -dir db/migrations postgres "${database_url}" "$@"; }
psql() { command psql "${database_url}" -v ON_ERROR_STOP=1 "$@"; }

tenant_id='00000000-0000-4000-8000-000000000001'
space_id='00000000-0000-4000-8000-000000000002'
episode_id='00000000-0000-4000-8000-000000000003'
participant_id='00000000-0000-4000-8000-000000000004'

# This is the same bounded sorted-object encoding used by the bridge and the
# Sync reducer's CanonicalJSON digest. It stays in the fixture so assertions
# independently prove the migration's digest and byte formulas.
psql <<'SQL'
create function fixture_canonical_json(value jsonb)
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
                    to_jsonb(entry.key)::text || ':' || fixture_canonical_json(entry.value),
                    ',' order by entry.key
                ),
                ''
            ) || '}'
            into encoded
            from jsonb_each(value) entry;
            return encoded;
        when 'array' then
            select '[' || coalesce(
                string_agg(fixture_canonical_json(entry.value), ',' order by entry.ordinality),
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

create function fixture_state_digest(value jsonb)
returns bytea
language sql
immutable
strict
as $$
    select sha256(
        convert_to('chalk-sync-state-v1', 'UTF8')
        || int4send(1)
        || convert_to(fixture_canonical_json(value), 'UTF8')
    )
$$;
SQL

psql <<SQL
insert into tenants (id, name)
values ('${tenant_id}', 'sync-retention-proof');

insert into spaces (id, name, tenant_id, slug, media_plane)
values ('${space_id}', 'Sync Retention Proof', '${tenant_id}', 'sync-retention-proof', 'cf_sfu');

insert into episodes (
    id, status, space_id, tenant_id, started_at, ended_at, config_snapshot, end_reason
)
values (
    '${episode_id}',
    'ended',
    '${space_id}',
    '${tenant_id}',
    now() - interval '9 days',
    now() - interval '8 days',
    '{
      "roles": {
        "facilitator": ["publishAudio", "publishVideo", "subscribe", "raiseHand"],
        "observer": ["subscribe"]
      },
      "admission_policy": {"mode": "open"},
      "default_episode_duration_seconds": 86400,
      "maximum_episode_duration_seconds": 86400,
      "linger_window_seconds": 0
    }'::jsonb,
    'explicit'
);

insert into participants (
    id, name, capabilities, tenant_id, space_id, episode_id,
    generation, status, role, joined_at, left_at
)
values (
    '${participant_id}',
    'Custom Facilitator',
    array['publishAudio', 'publishVideo', 'subscribe', 'raiseHand']::text[],
    '${tenant_id}',
    '${space_id}',
    '${episode_id}',
    1,
    'left',
    'facilitator',
    now() - interval '9 days',
    now() - interval '8 days'
);

insert into sync_episode_control (
    tenant_id, space_id, episode_id, control_revision, folded_state,
    state_schema_version, state_digest, snapshot_bytes,
    participant_event_count, participant_event_bytes,
    lifecycle_event_count, lifecycle_event_bytes,
    receipt_count, receipt_bytes
)
values (
    '${tenant_id}',
    '${space_id}',
    '${episode_id}',
    3,
    '{
      "admission_policy": "open",
      "admission_requests": [],
      "control_revision": 3,
      "deadline_at_ms": 1,
      "deadline_generation": 1,
      "participants": [],
      "recording": null,
      "role_capabilities": {
        "facilitator": ["publishAudio", "publishVideo", "subscribe", "raiseHand"],
        "observer": ["subscribe"]
      },
      "state_schema_version": 1,
      "status": "ended"
    }'::jsonb,
    1,
    fixture_state_digest(
        '{
          "admission_policy": "open",
          "admission_requests": [],
          "control_revision": 3,
          "deadline_at_ms": 1,
          "deadline_generation": 1,
          "participants": [],
          "recording": null,
          "role_capabilities": {
            "facilitator": ["publishAudio", "publishVideo", "subscribe", "raiseHand"],
            "observer": ["subscribe"]
          },
          "state_schema_version": 1,
          "status": "ended"
        }'::jsonb
    ),
    1,
    3,
    3,
    0,
    0,
    1,
    1
);

insert into sync_control_events (
    tenant_id, space_id, episode_id, event_id, base_revision, revision,
    event_name, payload, actor_participant_id, actor_generation, command_id,
    event_schema_version, resulting_state_digest, encoded_bytes
)
values
(
    '${tenant_id}', '${space_id}', '${episode_id}',
    '00000000-0000-4000-8000-000000000101', 0, 1,
    'participant_joined',
    jsonb_build_object(
        'participant_id', '${participant_id}',
        'display_name', 'Custom Facilitator',
        'role', 'facilitator',
        'admission_revision', 1
    ),
    '${participant_id}', 1, 'repair-fixture-cmd-0001',
    3, decode(repeat('ab', 32), 'hex'), 1
),
(
    '${tenant_id}', '${space_id}', '${episode_id}',
    '00000000-0000-4000-8000-000000000102', 1, 2,
    'participant_left',
    jsonb_build_object('participant_id', '${participant_id}', 'reason', 'left'),
    '${participant_id}', 1, 'repair-fixture-cmd-0002',
    3, decode(repeat('ab', 32), 'hex'), 1
),
(
    '${tenant_id}', '${space_id}', '${episode_id}',
    '00000000-0000-4000-8000-000000000103', 2, 3,
    'episode_ended',
    jsonb_build_object('reason', 'ended_by_participant'),
    '${participant_id}', 1, 'repair-fixture-cmd-0003',
    3, decode(repeat('ab', 32), 'hex'), 1
);

insert into sync_command_receipts (
    tenant_id, episode_id, participant_id, submitted_generation, command_id,
    request_fingerprint, command_name, outcome, event_id, resulting_revision,
    resulting_state_digest, completed_at
)
values (
    '${tenant_id}', '${episode_id}', '${participant_id}', 1,
    'repair-fixture-cmd-0001', decode(repeat('cd', 32), 'hex'),
    'set_display_name', 'committed',
    '00000000-0000-4000-8000-000000000101', 1,
    decode(repeat('ab', 32), 'hex'), now()
);
SQL

before_schema_versions="$(psql -At -c "select string_agg(event_schema_version::text, ',' order by revision) from sync_control_events where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'")"
if [[ "${before_schema_versions}" != "3,3,3" ]]; then
  echo "Fixture did not start with retained v3 rows: ${before_schema_versions}" >&2
  exit 1
fi

if [[ "${proof_case}" == "unsupported_payload" ]]; then
  psql -c "update sync_control_events set payload = payload || '{\"unsupported\":true}'::jsonb where tenant_id = '${tenant_id}' and episode_id = '${episode_id}' and revision = 1"
fi

set +e
migration_output="$(goose up 2>&1)"
migration_status=$?
set -e

if [[ "${proof_case}" == "unsupported_payload" ]]; then
  if [[ "${migration_status}" -eq 0 ]]; then
    echo "Expected unsupported v3 payload to abort the repair migration." >&2
    exit 1
  fi
  if [[ "${migration_output}" != *"unsupported bridged event payload"* ]]; then
    echo "Unsupported payload failed without the repair preflight error:" >&2
    echo "${migration_output}" >&2
    exit 1
  fi
  after_schema_versions="$(psql -At -c "select string_agg(event_schema_version::text, ',' order by revision) from sync_control_events where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'")"
  if [[ "${after_schema_versions}" != "3,3,3" ]]; then
    echo "Fail-closed repair changed unsupported rows: ${after_schema_versions}" >&2
    exit 1
  fi
  version="$(psql -At -c 'select version_id from goose_db_version order by id desc limit 1')"
  if [[ "${version}" != "20260808150000" ]]; then
    echo "Goose advanced after rejected repair: ${version}" >&2
    exit 1
  fi
  echo "Sync retained-event repair proof passed: unsupported payload aborted atomically at Goose ${version}."
  exit 0
fi

if [[ "${migration_status}" -ne 0 ]]; then
  echo "Valid custom-role retained-event fixture failed repair:" >&2
  echo "${migration_output}" >&2
  exit 1
fi

schema_versions="$(psql -At -c "select string_agg(event_schema_version::text, ',' order by revision) from sync_control_events where tenant_id = '${tenant_id}' and episode_id = '${episode_id}'")"
if [[ "${schema_versions}" != "1,1,1" ]]; then
  echo "Repair did not rewrite every event schema version: ${schema_versions}" >&2
  exit 1
fi

digest_checks="$(psql -At <<SQL
with expected(revision, state) as (
    values
    (1, jsonb_build_object(
        'admission_policy', 'open',
        'admission_requests', '[]'::jsonb,
        'control_revision', 1,
        'deadline_at_ms', 1,
        'deadline_generation', 1,
        'participants', jsonb_build_array(jsonb_build_object(
            'participant_id', '${participant_id}',
            'display_name', 'Custom Facilitator',
            'hand_raised', false,
            'role', 'facilitator',
            'capabilities', jsonb_build_array('publishAudio', 'publishVideo', 'subscribe', 'raiseHand'),
            'admission_revision', 1
        )),
        'recording', null,
        'role_capabilities', jsonb_build_object(
            'facilitator', jsonb_build_array('publishAudio', 'publishVideo', 'subscribe', 'raiseHand'),
            'observer', jsonb_build_array('subscribe')
        ),
        'state_schema_version', 1,
        'status', 'active'
    )),
    (2, jsonb_build_object(
        'admission_policy', 'open',
        'admission_requests', '[]'::jsonb,
        'control_revision', 2,
        'deadline_at_ms', 1,
        'deadline_generation', 1,
        'participants', '[]'::jsonb,
        'recording', null,
        'role_capabilities', jsonb_build_object(
            'facilitator', jsonb_build_array('publishAudio', 'publishVideo', 'subscribe', 'raiseHand'),
            'observer', jsonb_build_array('subscribe')
        ),
        'state_schema_version', 1,
        'status', 'active'
    )),
    (3, jsonb_build_object(
        'admission_policy', 'open',
        'admission_requests', '[]'::jsonb,
        'control_revision', 3,
        'deadline_at_ms', 1,
        'deadline_generation', 1,
        'participants', '[]'::jsonb,
        'recording', null,
        'role_capabilities', jsonb_build_object(
            'facilitator', jsonb_build_array('publishAudio', 'publishVideo', 'subscribe', 'raiseHand'),
            'observer', jsonb_build_array('subscribe')
        ),
        'state_schema_version', 1,
        'status', 'ended'
    ))
)
select count(*) || ':' || count(*) filter (
    where event.resulting_state_digest = fixture_state_digest(expected.state)
) || ':' || count(*) filter (
    where event.encoded_bytes = octet_length(fixture_canonical_json(
        jsonb_build_object(
            'event_id', event.event_id,
            'base_revision', event.base_revision,
            'revision', event.revision,
            'name', event.event_name,
            'payload', event.payload,
            'command_id', event.command_id,
            'lifecycle_intent_id', event.lifecycle_intent_id,
            'schema_version', event.event_schema_version,
            'resulting_state_digest', encode(event.resulting_state_digest, 'hex')
        )
    ))
)
from sync_control_events event
join expected on expected.revision = event.revision
where event.tenant_id = '${tenant_id}' and event.episode_id = '${episode_id}';
SQL
)"
if [[ "${digest_checks}" != "3:3:3" ]]; then
  echo "Digest or encoded-byte formula mismatch: ${digest_checks}" >&2
  exit 1
fi

counter_checks="$(psql -At <<SQL
select
    control_revision = 3
    and state_schema_version = 1
    and state_digest = fixture_state_digest(folded_state)
    and snapshot_bytes = octet_length(fixture_canonical_json(
        folded_state || jsonb_build_object('state_digest', encode(state_digest, 'hex'))
    ))
    and participant_event_count = 3
    and participant_event_bytes = (select coalesce(sum(encoded_bytes), 0) from sync_control_events where tenant_id = '${tenant_id}' and episode_id = '${episode_id}')
    and lifecycle_event_count = 0
    and lifecycle_event_bytes = 0
    and lifecycle_intent_count = 0
    and lifecycle_intent_bytes = 0
    and receipt_count = 1
    and receipt_bytes = (
        select octet_length(fixture_canonical_json(jsonb_build_object(
            'command_id', receipt.command_id,
            'command_name', receipt.command_name,
            'outcome', receipt.outcome,
            'rejection_reason', receipt.rejection_reason,
            'event_id', receipt.event_id,
            'resulting_revision', receipt.resulting_revision,
            'resulting_state_digest', encode(receipt.resulting_state_digest, 'hex'),
            'request_fingerprint', replace(
                replace(rtrim(encode(receipt.request_fingerprint, 'base64'), '='), '+', '-'),
                '/', '_'
            )
        )))
        from sync_command_receipts receipt
        where receipt.tenant_id = '${tenant_id}' and receipt.episode_id = '${episode_id}'
    )
from sync_episode_control
where tenant_id = '${tenant_id}' and episode_id = '${episode_id}';
SQL
)"
if [[ "${counter_checks}" != "t" ]]; then
  echo "Derived control counters or snapshot bytes were not rebuilt: ${counter_checks}" >&2
  exit 1
fi

set +e
rollback_output="$(goose down 2>&1)"
rollback_status=$?
set -e
if [[ "${rollback_status}" -eq 0 || "${rollback_output}" != *"irreversible"* ]]; then
  echo "Repair Down did not fail with the deliberate irreversible error:" >&2
  echo "${rollback_output}" >&2
  exit 1
fi
version="$(psql -At -c 'select version_id from goose_db_version order by id desc limit 1')"
if [[ "${version}" != "20260809160000" ]]; then
  echo "Goose version changed after refused repair rollback: ${version}" >&2
  exit 1
fi

cleanup_output="$(
  cd "${repository_root}/apps/sync"
  CHALK_DATABASE_URL="${database_url}" MIX_ENV=test mix run --no-start -e '
    {:ok, _applications} = Application.ensure_all_started(:postgrex)
    {:ok, options} = ChalkSync.Database.connection_options(System.fetch_env!("CHALK_DATABASE_URL"))
    {:ok, connection} = Postgrex.start_link(options)
    tenant_id = "00000000-0000-4000-8000-000000000001"
    episode_id = "00000000-0000-4000-8000-000000000003"
    rows =
      Postgrex.query!(
        connection,
        """
        select event_id, base_revision, revision, event_name, payload,
          command_id, lifecycle_intent_id, event_schema_version,
          resulting_state_digest, external_operation_id,
          actor_participant_id, actor_generation, encoded_bytes
        from sync_control_events
        where tenant_id = $1 and episode_id = $2
        order by revision
        """,
        [ChalkSync.UUID.dump!(tenant_id), ChalkSync.UUID.dump!(episode_id)]
      ).rows

    Enum.each(rows, fn [event_id, base_revision, revision, event_name, payload,
                       command_id, lifecycle_intent_id, schema_version,
                       resulting_state_digest, external_operation_id,
                       actor_participant_id, actor_generation, encoded_bytes] ->
      event = %{
        event_id: ChalkSync.UUID.load!(event_id),
        base_revision: base_revision,
        revision: revision,
        name: event_name,
        payload: payload,
        command_id: command_id,
        lifecycle_intent_id: lifecycle_intent_id && ChalkSync.UUID.load!(lifecycle_intent_id),
        schema_version: schema_version,
        resulting_state_digest: resulting_state_digest
      }

      event =
        if external_operation_id do
          Map.merge(event, %{
            external_operation_id: ChalkSync.UUID.load!(external_operation_id),
            actor_participant_id: actor_participant_id && ChalkSync.UUID.load!(actor_participant_id),
            actor_generation: actor_generation
          })
        else
          event
        end

      expected_bytes =
        event
        |> Map.update!(:resulting_state_digest, &Base.encode16(&1, case: :lower))
        |> JSON.encode!()
        |> byte_size()

      unless expected_bytes == encoded_bytes do
        raise "Sync JSON event-byte formula mismatch at revision #{revision}"
      end
    end)

    [[receipt_command_id, command_name, outcome, rejection_reason, event_id,
      resulting_revision, resulting_state_digest, request_fingerprint]] =
      Postgrex.query!(
        connection,
        """
        select command_id, command_name, outcome, rejection_reason, event_id,
          resulting_revision, resulting_state_digest, request_fingerprint
        from sync_command_receipts
        where tenant_id = $1 and episode_id = $2
        """,
        [ChalkSync.UUID.dump!(tenant_id), ChalkSync.UUID.dump!(episode_id)]
      ).rows

    [[receipt_bytes]] =
      Postgrex.query!(
        connection,
        "select receipt_bytes from sync_episode_control where tenant_id = $1 and episode_id = $2",
        [ChalkSync.UUID.dump!(tenant_id), ChalkSync.UUID.dump!(episode_id)]
      ).rows

    receipt = %{
      "command_id" => receipt_command_id,
      "command_name" => command_name,
      "outcome" => outcome,
      "rejection_reason" => rejection_reason,
      "event_id" => event_id && ChalkSync.UUID.load!(event_id),
      "resulting_revision" => resulting_revision,
      "resulting_state_digest" => resulting_state_digest && Base.encode16(resulting_state_digest, case: :lower),
      "request_fingerprint" => Base.url_encode64(request_fingerprint, padding: false)
    }

    unless JSON.encode!(receipt) |> byte_size() == receipt_bytes do
      raise "Sync JSON receipt-byte formula mismatch"
    end

    result =
      ChalkSync.Retention.CleanupWorker.run_once(
        connection,
        clock: fn -> ~U[2026-08-20 00:00:00Z] end
      )
    IO.inspect(result, label: "cleanup")
    unless match?({:ok, %{episodes: 1}}, result), do: System.halt(1)
    GenServer.stop(connection)
  '
)"
history_after_cleanup="$(psql -At -c "select (select count(*) from sync_control_events where tenant_id = '${tenant_id}' and episode_id = '${episode_id}') || ':' || (select count(*) from sync_command_receipts where tenant_id = '${tenant_id}' and episode_id = '${episode_id}') || ':' || (select retention_cleaned_at is not null from sync_episode_control where tenant_id = '${tenant_id}' and episode_id = '${episode_id}')")"
if [[ "${history_after_cleanup}" != "0:0:true" ]]; then
  echo "CleanupWorker did not fold and clean the repaired custom-role history: ${history_after_cleanup}" >&2
  echo "${cleanup_output}" >&2
  exit 1
fi

echo "Sync retained-event repair migration proof passed: custom role policy folded v3 rows to v1 with independent digest/byte checks; Down remained irreversible."

# Keep the migration proof independent of the Elixir implementation. The
# parent fixture invokes CleanupWorker against this same live-shaped database
# when the Sync integration dependencies are present.
psql -c 'drop function fixture_state_digest(jsonb); drop function fixture_canonical_json(jsonb);'
