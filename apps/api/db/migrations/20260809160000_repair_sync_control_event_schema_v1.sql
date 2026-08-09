-- +goose Up
-- The Space/Episode bridge translated retained control-event payloads and
-- vocabulary, but it copied the legacy event schema version and integrity
-- values.  Rebuild those values from the target Sync v1 reducer in one
-- transaction.  The repair is deliberately fail-closed: an event that is
-- not a known target contract, or that does not fold to the target control
-- snapshot, aborts the migration before any durable row is changed.

-- +goose StatementBegin
create function __chalk_repair_sync_v1_canonical_json(value jsonb)
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
                    to_jsonb(entry.key)::text || ':' ||
                        __chalk_repair_sync_v1_canonical_json(entry.value),
                    ',' order by entry.key
                ),
                ''
            ) || '}'
            into encoded
            from jsonb_each(value) entry;
            return encoded;
        when 'array' then
            select '[' || coalesce(
                string_agg(
                    __chalk_repair_sync_v1_canonical_json(entry.value),
                    ',' order by entry.ordinality
                ),
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
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_state_digest(value jsonb)
returns bytea
language sql
immutable
as $$
    select sha256(
        convert_to('chalk-sync-state-v1', 'UTF8')
        || int4send(1)
        || convert_to(__chalk_repair_sync_v1_canonical_json(value), 'UTF8')
    )
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_exact_keys(value jsonb, expected text[])
returns boolean
language sql
immutable
as $$
    select jsonb_typeof(value) = 'object'
        and coalesce(
            (select array_agg(key order by key) from jsonb_object_keys(value) key),
            '{}'::text[]
        ) = coalesce(
            (select array_agg(key order by key) from unnest(expected) key),
            '{}'::text[]
        )
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_uuid(value text)
returns boolean
language sql
immutable
strict
as $$
    select value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_positive_integer(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
begin
    return jsonb_typeof(value) = 'number'
        and value #>> '{}' ~ '^[0-9]+$'
        and (value #>> '{}')::bigint > 0;
exception
    when others then
        return false;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_string(value jsonb, minimum_bytes integer, maximum_bytes integer)
returns boolean
language sql
immutable
strict
as $$
    select jsonb_typeof(value) = 'string'
        and octet_length(value #>> '{}') between minimum_bytes and maximum_bytes
        and value #>> '{}' = btrim(value #>> '{}')
$$;
-- +goose StatementEnd

-- Reducer snapshots accept at most sixteen role bundles and the same bounded
-- capability vocabulary used by ChalkSync.Episodes.Reducer.  Validate the
-- immutable Episode policy before folding so a malformed policy cannot be
-- mistaken for a successful v1 repair.
-- +goose StatementBegin
create function __chalk_repair_sync_v1_valid_role_capabilities(value jsonb)
returns boolean
language sql
immutable
strict
as $$
    select jsonb_typeof(value) = 'object'
        and (select count(*) from jsonb_each(value)) between 1 and 16
        and not exists (
            select 1
            from jsonb_each(value) role_entry
            where jsonb_typeof(role_entry.value) <> 'array'
                or octet_length(role_entry.key) not between 1 and 64
                or role_entry.key <> btrim(role_entry.key)
                or jsonb_array_length(role_entry.value) > 23
                or exists (
                    select 1
                    from jsonb_array_elements_text(role_entry.value) capability
                    where capability not in (
                        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
                        'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
                        'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
                        'assignRoles', 'muteOthers', 'stopVideoOthers',
                        'stopScreenOthers', 'requestMediaOthers', 'removeParticipant',
                        'manageRecording', 'startEpisode', 'extendEpisode',
                        'endEpisode', 'manageMembers', 'clearSpaceContent'
                    )
                )
                or (
                    select count(*)
                    from jsonb_array_elements_text(role_entry.value)
                ) <> (
                    select count(distinct capability)
                    from jsonb_array_elements_text(role_entry.value) capability
                )
        )
$$;
-- +goose StatementEnd

-- The bridge already rewrote legacy keys and names.  This validator accepts
-- only the target event vocabulary and exact payload shapes.  It also keeps
-- the migration independent from permissive JSON casts: malformed values
-- return false and are rejected by the preflight below.
-- +goose StatementBegin
create function __chalk_repair_sync_v1_valid_event_payload(event_name text, payload jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    value text;
begin
    if jsonb_typeof(payload) <> 'object' then
        return false;
    end if;

    case
        when event_name = 'episode_started' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['episode_id'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'episode_id');
        when event_name = 'participant_joined' then
            return __chalk_repair_sync_v1_exact_keys(
                payload,
                array['participant_id', 'display_name', 'role', 'admission_revision']
            )
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id')
                and __chalk_repair_sync_v1_string(payload -> 'display_name', 1, 256)
                and __chalk_repair_sync_v1_string(payload -> 'role', 1, 64)
                and __chalk_repair_sync_v1_positive_integer(payload -> 'admission_revision');
        when event_name = 'participant_left' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['participant_id', 'reason'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id')
                and payload ->> 'reason' in ('left', 'removed');
        when event_name in ('hand_raised', 'hand_lowered') then
            return __chalk_repair_sync_v1_exact_keys(payload, array['participant_id'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id');
        when event_name = 'participant_display_name_changed' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['participant_id', 'display_name'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id')
                and __chalk_repair_sync_v1_string(payload -> 'display_name', 1, 256);
        when event_name = 'admission_policy_changed' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['policy'])
                and payload ->> 'policy' in ('open', 'knock', 'members_only');
        when event_name = 'role_assigned' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['participant_id', 'role'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id')
                and __chalk_repair_sync_v1_string(payload -> 'role', 1, 64);
        when event_name = 'deadline_changed' then
            return __chalk_repair_sync_v1_exact_keys(
                payload,
                array['deadline_at_ms', 'deadline_generation']
            )
                and __chalk_repair_sync_v1_positive_integer(payload -> 'deadline_at_ms')
                and __chalk_repair_sync_v1_positive_integer(payload -> 'deadline_generation');
        when event_name = 'admission_requested' then
            return __chalk_repair_sync_v1_exact_keys(
                payload,
                array[
                    'admission_request_id',
                    'participant_id',
                    'display_name',
                    'role',
                    'expires_at_ms'
                ]
            )
                and __chalk_repair_sync_v1_uuid(payload ->> 'admission_request_id')
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id')
                and __chalk_repair_sync_v1_string(payload -> 'display_name', 1, 256)
                and __chalk_repair_sync_v1_string(payload -> 'role', 1, 64)
                and __chalk_repair_sync_v1_positive_integer(payload -> 'expires_at_ms');
        when event_name in ('admission_denied', 'admission_expired') then
            return __chalk_repair_sync_v1_exact_keys(payload, array['admission_request_id'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'admission_request_id');
        when event_name in (
            'participant_microphone_stopped',
            'participant_camera_stopped',
            'participant_screen_share_stopped'
        ) then
            return __chalk_repair_sync_v1_exact_keys(payload, array['participant_id'])
                and __chalk_repair_sync_v1_uuid(payload ->> 'participant_id');
        when event_name = 'recording_status_changed' then
            value := payload ->> 'failure_code';
            return __chalk_repair_sync_v1_exact_keys(
                payload,
                array['recording_id', 'status', 'failure_code']
            )
                and __chalk_repair_sync_v1_uuid(payload ->> 'recording_id')
                and payload ->> 'status' in ('starting', 'recording', 'stopping', 'stopped', 'failed')
                and (
                    (payload -> 'failure_code') is null
                    or jsonb_typeof(payload -> 'failure_code') = 'null'
                    or __chalk_repair_sync_v1_string(payload -> 'failure_code', 1, 96)
                )
                and (
                    (payload ->> 'status' = 'failed'
                        and __chalk_repair_sync_v1_string(payload -> 'failure_code', 1, 96))
                    or (payload ->> 'status' <> 'failed'
                        and jsonb_typeof(payload -> 'failure_code') = 'null')
                );
        when event_name = 'episode_ended' then
            return __chalk_repair_sync_v1_exact_keys(payload, array['reason'])
                and payload ->> 'reason' in (
                    'ended_by_participant',
                    'tenant_recovery',
                    'maximum_duration'
                );
        else
            return false;
    end case;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_sort_array(value jsonb, key_name text)
returns jsonb
language sql
immutable
strict
as $$
    select coalesce(
        jsonb_agg(item order by item ->> key_name),
        '[]'::jsonb
    )
    from jsonb_array_elements(value) item
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_apply_event(
    state jsonb,
    episode_id uuid,
    event_name text,
    payload jsonb
)
returns jsonb
language plpgsql
immutable
strict
as $$
declare
    next_state jsonb := state;
    participants jsonb;
    admission_requests jsonb;
    participant jsonb;
    request jsonb;
    recording jsonb;
    participant_id text := payload ->> 'participant_id';
    request_id text := payload ->> 'admission_request_id';
    role_name text := payload ->> 'role';
    existing_role text;
    current_recording_id text;
    current_recording_status text;
    next_recording_status text;
begin
    if not __chalk_repair_sync_v1_valid_event_payload(event_name, payload) then
        raise exception 'Sync v1 event payload is unsupported for %', event_name;
    end if;

    if state ->> 'status' = 'ended' then
        raise exception 'Sync v1 event follows an ended Episode at revision %', state ->> 'control_revision';
    end if;

    participants := state -> 'participants';
    admission_requests := state -> 'admission_requests';

    case
        when event_name = 'episode_started' then
            if (state ->> 'control_revision')::bigint <> 0
                or payload ->> 'episode_id' <> episode_id::text then
                raise exception 'Sync v1 episode_started transition is invalid';
            end if;
        when event_name = 'participant_joined' then
            if exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 participant_joined transition repeats a Participant';
            end if;
            if not (state -> 'role_capabilities' ? role_name) then
                raise exception 'Sync v1 participant_joined transition targets an unknown role';
            end if;
            if exists (
                select 1
                from jsonb_array_elements(admission_requests) item
                where item ->> 'participant_id' = participant_id
                  and (
                      item ->> 'display_name' is distinct from payload ->> 'display_name'
                      or item ->> 'role' is distinct from payload ->> 'role'
                  )
            ) then
                raise exception 'Sync v1 participant_joined transition mismatches an admission request';
            end if;

            participants := participants || jsonb_build_array(
                jsonb_build_object(
                    'participant_id', participant_id,
                    'display_name', payload -> 'display_name',
                    'hand_raised', false,
                    'role', role_name,
                    'capabilities', coalesce(state -> 'role_capabilities' -> role_name, '[]'::jsonb),
                    'admission_revision', payload -> 'admission_revision'
                )
            );
            participants := __chalk_repair_sync_v1_sort_array(participants, 'participant_id');

            select coalesce(jsonb_agg(item order by item ->> 'admission_request_id'), '[]'::jsonb)
            into admission_requests
            from jsonb_array_elements(admission_requests) item
            where item ->> 'participant_id' <> participant_id;
        when event_name = 'participant_left' then
            if not exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 participant_left transition targets no Participant';
            end if;
            participants := (
                select coalesce(jsonb_agg(item order by item ->> 'participant_id'), '[]'::jsonb)
                from jsonb_array_elements(participants) item
                where item ->> 'participant_id' <> participant_id
            );
        when event_name in ('hand_raised', 'hand_lowered') then
            if not exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 hand transition targets no Participant';
            end if;
            if exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
                  and (item ->> 'hand_raised')::boolean = (event_name = 'hand_raised')
            ) then
                raise exception 'Sync v1 hand transition is a no-op';
            end if;
            participants := (
                select coalesce(jsonb_agg(
                    case when item ->> 'participant_id' = participant_id
                        then jsonb_set(item, '{hand_raised}', to_jsonb(event_name = 'hand_raised'))
                        else item
                    end
                    order by item ->> 'participant_id'
                ), '[]'::jsonb)
                from jsonb_array_elements(participants) item
            );
        when event_name = 'participant_display_name_changed' then
            if not exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 display-name transition targets no Participant';
            end if;
            if exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
                  and item ->> 'display_name' = payload ->> 'display_name'
            ) then
                raise exception 'Sync v1 display-name transition is a no-op';
            end if;
            participants := (
                select coalesce(jsonb_agg(
                    case when item ->> 'participant_id' = participant_id
                        then jsonb_set(item, '{display_name}', payload -> 'display_name')
                        else item
                    end
                    order by item ->> 'participant_id'
                ), '[]'::jsonb)
                from jsonb_array_elements(participants) item
            );
        when event_name = 'admission_policy_changed' then
            if payload ->> 'policy' = state ->> 'admission_policy' then
                raise exception 'Sync v1 admission policy transition is a no-op';
            end if;
            next_state := jsonb_set(next_state, '{admission_policy}', payload -> 'policy');
        when event_name = 'role_assigned' then
            select item ->> 'role'
            into existing_role
            from jsonb_array_elements(participants) item
            where item ->> 'participant_id' = participant_id;
            if existing_role is null
                or existing_role = role_name
                or not (state -> 'role_capabilities' ? role_name) then
                raise exception 'Sync v1 role transition targets an invalid Participant';
            end if;
            participants := (
                select coalesce(jsonb_agg(
                    case when item ->> 'participant_id' = participant_id
                        then jsonb_set(
                            jsonb_set(item, '{role}', payload -> 'role'),
                            '{capabilities}',
                            coalesce(state -> 'role_capabilities' -> role_name, '[]'::jsonb)
                        )
                        else item
                    end
                    order by item ->> 'participant_id'
                ), '[]'::jsonb)
                from jsonb_array_elements(participants) item
            );
        when event_name = 'deadline_changed' then
            if (payload ->> 'deadline_generation')::bigint
                <> (state ->> 'deadline_generation')::bigint + 1 then
                raise exception 'Sync v1 deadline transition skips a generation';
            end if;
            next_state := jsonb_set(next_state, '{deadline_at_ms}', payload -> 'deadline_at_ms');
            next_state := jsonb_set(next_state, '{deadline_generation}', payload -> 'deadline_generation');
        when event_name = 'admission_requested' then
            if exists (
                select 1 from jsonb_array_elements(admission_requests) item
                where item ->> 'admission_request_id' = request_id
                   or item ->> 'participant_id' = participant_id
            ) or exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 admission request transition repeats a target';
            end if;
            admission_requests := admission_requests || jsonb_build_array(payload);
            admission_requests := __chalk_repair_sync_v1_sort_array(
                admission_requests,
                'admission_request_id'
            );
        when event_name in ('admission_denied', 'admission_expired') then
            if not exists (
                select 1 from jsonb_array_elements(admission_requests) item
                where item ->> 'admission_request_id' = request_id
            ) then
                raise exception 'Sync v1 admission decision targets no request';
            end if;
            admission_requests := (
                select coalesce(jsonb_agg(item order by item ->> 'admission_request_id'), '[]'::jsonb)
                from jsonb_array_elements(admission_requests) item
                where item ->> 'admission_request_id' <> request_id
            );
        when event_name in (
            'participant_microphone_stopped',
            'participant_camera_stopped',
            'participant_screen_share_stopped'
        ) then
            if not exists (
                select 1 from jsonb_array_elements(participants) item
                where item ->> 'participant_id' = participant_id
            ) then
                raise exception 'Sync v1 publication transition targets no Participant';
            end if;
        when event_name = 'recording_status_changed' then
            recording := payload;
            next_recording_status := payload ->> 'status';
            current_recording_status := state -> 'recording' ->> 'status';
            current_recording_id := state -> 'recording' ->> 'recording_id';
            if state -> 'recording' is null
                or jsonb_typeof(state -> 'recording') = 'null' then
                if next_recording_status <> 'starting' then
                    raise exception 'Sync v1 recording transition does not start a recording';
                end if;
            elsif current_recording_id = payload ->> 'recording_id' then
                if not (
                    (current_recording_status = 'starting' and next_recording_status in ('recording', 'failed'))
                    or (current_recording_status = 'recording' and next_recording_status in ('stopping', 'failed'))
                    or (current_recording_status = 'stopping' and next_recording_status in ('stopped', 'failed'))
                ) then
                    raise exception 'Sync v1 recording transition is invalid';
                end if;
            elsif next_recording_status <> 'starting'
                or current_recording_status not in ('stopped', 'failed') then
                raise exception 'Sync v1 recording transition changes identity incorrectly';
            end if;
            next_state := jsonb_set(next_state, '{recording}', recording);
        when event_name = 'episode_ended' then
            next_state := jsonb_set(next_state, '{status}', '"ended"'::jsonb);
            participants := '[]'::jsonb;
            admission_requests := '[]'::jsonb;
            next_state := jsonb_set(next_state, '{recording}', 'null'::jsonb);
        else
            raise exception 'Sync v1 event name is unsupported: %', event_name;
    end case;

    next_state := jsonb_set(next_state, '{participants}', participants);
    next_state := jsonb_set(next_state, '{admission_requests}', admission_requests);
    next_state := jsonb_set(
        next_state,
        '{control_revision}',
        to_jsonb((state ->> 'control_revision')::bigint + 1)
    );
    return next_state;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_event_bytes(
    event_id uuid,
    base_revision bigint,
    revision bigint,
    event_name text,
    payload jsonb,
    command_id text,
    lifecycle_intent_id uuid,
    external_operation_id uuid,
    actor_participant_id uuid,
    actor_generation bigint,
    schema_version integer,
    resulting_state_digest bytea
)
returns integer
language sql
immutable
as $$
    select octet_length(
        __chalk_repair_sync_v1_canonical_json(
            jsonb_build_object(
                'event_id', event_id,
                'base_revision', base_revision,
                'revision', revision,
                'name', event_name,
                'payload', payload,
                'command_id', command_id,
                'lifecycle_intent_id', lifecycle_intent_id,
                'schema_version', schema_version,
                'resulting_state_digest', encode(resulting_state_digest, 'hex')
            ) || case when external_operation_id is not null then
                jsonb_build_object(
                    'external_operation_id', external_operation_id,
                    'actor_participant_id', actor_participant_id,
                    'actor_generation', actor_generation
                )
            else '{}'::jsonb end
        )
    )
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_sync_v1_receipt_bytes(
    command_id text,
    command_name text,
    outcome text,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    resulting_state_digest bytea,
    request_fingerprint bytea
)
returns integer
language sql
immutable
as $$
    select octet_length(
        __chalk_repair_sync_v1_canonical_json(
            jsonb_build_object(
                'command_id', command_id,
                'command_name', command_name,
                'outcome', outcome,
                'rejection_reason', rejection_reason,
                'event_id', event_id,
                'resulting_revision', resulting_revision,
                'resulting_state_digest', encode(resulting_state_digest, 'hex'),
                'request_fingerprint', replace(
                    replace(
                        rtrim(encode(request_fingerprint, 'base64'), '='),
                        '+',
                        '-'
                    ),
                    '/',
                    '_'
                )
            )
        )
    )
$$;
-- +goose StatementEnd

-- +goose StatementBegin
do $$
declare
    control record;
    event_row record;
    state jsonb;
    event_digest bytea;
    initial_policy text;
    initial_roles jsonb;
    expected_snapshot jsonb;
    expected_digest bytea;
    expected_snapshot_bytes bigint;
    repaired_event_count bigint;
    repaired_participant_event_count bigint;
    repaired_participant_event_bytes bigint;
    repaired_lifecycle_event_count bigint;
    repaired_lifecycle_event_bytes bigint;
    repaired_lifecycle_intent_count bigint;
    repaired_lifecycle_intent_bytes bigint;
    repaired_receipt_count bigint;
    repaired_receipt_bytes bigint;
begin
    if to_regclass('sync_control_events') is null
        or to_regclass('sync_episode_control') is null
        or to_regclass('episodes') is null then
        raise exception 'Sync v1 event repair requires the Space/Episode control schema';
    end if;

    if exists (
        select 1
        from sync_control_events
        where event_schema_version not in (1, 3)
    ) then
        raise exception 'Sync v1 event repair found an unsupported event schema version';
    end if;

    if exists (
        select 1
        from sync_control_events event
        where event.event_schema_version = 3
          and (
              event.event_name in ('session_ended', 'end_session', 'transfer_host')
              or event.payload ?| array[
                  'room_id',
                  'session_id',
                  'participant_session_id',
                  'actor_participant_session_id',
                  'target_participant_session_id',
                  'granted_by_participant_session_id',
                  'started_by_participant_session_id',
                  'host_participant_session_id',
                  'participant_session_generation'
              ]
          )
    ) then
        raise exception 'Sync v1 event repair found an unbridged legacy event vocabulary';
    end if;

    if exists (
        select 1
        from sync_control_events event
        where event.event_schema_version = 3
          and not __chalk_repair_sync_v1_valid_event_payload(event.event_name, event.payload)
    ) then
        raise exception 'Sync v1 event repair found an unsupported bridged event payload';
    end if;

    if exists (
        select 1
        from sync_episode_control candidate
        where exists (
            select 1
            from sync_control_events event
            where event.tenant_id = candidate.tenant_id
              and event.episode_id = candidate.episode_id
              and event.event_schema_version = 3
        )
          and (
              candidate.state_schema_version <> 1
           or coalesce((candidate.folded_state ->> 'state_schema_version')::integer, 0) <> 1
              or candidate.retention_cleaned_at is not null
          )
    ) then
        raise exception 'Sync v1 event repair found an unsupported control snapshot';
    end if;

    for control in
        select candidate.*, episode.config_snapshot
        from sync_episode_control candidate
        join episodes episode
          on episode.tenant_id = candidate.tenant_id
         and episode.space_id = candidate.space_id
         and episode.id = candidate.episode_id
        where exists (
            select 1
            from sync_control_events event
            where event.tenant_id = candidate.tenant_id
              and event.episode_id = candidate.episode_id
              and event.event_schema_version = 3
        )
        order by candidate.tenant_id, candidate.episode_id
        for update of candidate
    loop
        initial_roles := coalesce(
            control.config_snapshot -> 'roles',
            control.folded_state -> 'role_capabilities'
        );
        if not __chalk_repair_sync_v1_valid_role_capabilities(initial_roles) then
            raise exception 'Sync v1 event repair found an unsupported role policy for Episode %', control.episode_id;
        end if;

        initial_policy := coalesce(
            control.config_snapshot -> 'admission_policy' ->> 'mode',
            'open'
        );
        if initial_policy not in ('open', 'knock', 'members_only') then
            raise exception 'Sync v1 event repair found an unsupported admission policy for Episode %', control.episode_id;
        end if;

        state := jsonb_build_object(
            'admission_policy', initial_policy,
            'admission_requests', '[]'::jsonb,
            'control_revision', 0,
            'deadline_at_ms', 1,
            'deadline_generation', 1,
            'participants', '[]'::jsonb,
            'recording', null,
            'role_capabilities', initial_roles,
            'state_schema_version', 1,
            'status', 'active'
        );

        for event_row in
            select *
            from sync_control_events
            where tenant_id = control.tenant_id
              and episode_id = control.episode_id
            order by revision
        loop
            if event_row.base_revision <> (state ->> 'control_revision')::bigint
                or event_row.revision <> event_row.base_revision + 1 then
                raise exception 'Sync v1 event repair found a revision gap for Episode %', control.episode_id;
            end if;

            state := __chalk_repair_sync_v1_apply_event(
                state,
                control.episode_id,
                event_row.event_name,
                event_row.payload
            );
            event_digest := __chalk_repair_sync_v1_state_digest(state);

            update sync_control_events
            set event_schema_version = 1,
                resulting_state_digest = event_digest,
                encoded_bytes = __chalk_repair_sync_v1_event_bytes(
                    event_id,
                    base_revision,
                    revision,
                    event_name,
                    payload,
                    command_id,
                    lifecycle_intent_id,
                    external_operation_id,
                    actor_participant_id,
                    actor_generation,
                    1,
                    event_digest
                )
            where tenant_id = event_row.tenant_id
              and episode_id = event_row.episode_id
              and revision = event_row.revision;
        end loop;

        expected_snapshot := control.folded_state;
        if not __chalk_repair_sync_v1_valid_role_capabilities(
            expected_snapshot -> 'role_capabilities'
        ) then
            raise exception 'Sync v1 event repair found an unsupported terminal role policy for Episode %', control.episode_id;
        end if;
        expected_digest := __chalk_repair_sync_v1_state_digest(state);
        expected_snapshot_bytes := octet_length(
            __chalk_repair_sync_v1_canonical_json(
                state || jsonb_build_object('state_digest', encode(expected_digest, 'hex'))
            )
        );
        if state <> expected_snapshot
            or expected_digest <> control.state_digest
            or (state ->> 'control_revision')::bigint <> control.control_revision then
            raise exception 'Sync v1 event repair fold diverges from the Episode control snapshot for %', control.episode_id;
        end if;

        select
            count(*)::bigint,
            count(*) filter (where lifecycle_intent_id is null)::bigint,
            coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is null), 0)::bigint,
            count(*) filter (where lifecycle_intent_id is not null)::bigint,
            coalesce(sum(encoded_bytes) filter (where lifecycle_intent_id is not null), 0)::bigint
        into repaired_event_count,
            repaired_participant_event_count,
            repaired_participant_event_bytes,
            repaired_lifecycle_event_count,
            repaired_lifecycle_event_bytes
        from sync_control_events
        where tenant_id = control.tenant_id
          and episode_id = control.episode_id;

        select count(*)::bigint,
            coalesce(sum(octet_length(payload::text)), 0)::bigint
        into repaired_lifecycle_intent_count, repaired_lifecycle_intent_bytes
        from sync_lifecycle_intents
        where tenant_id = control.tenant_id
          and episode_id = control.episode_id;

        update sync_command_receipts receipt
        set resulting_state_digest = event.resulting_state_digest
        from sync_control_events event
        where receipt.tenant_id = control.tenant_id
          and receipt.episode_id = control.episode_id
          and receipt.event_id = event.event_id
          and receipt.resulting_revision = event.revision
          and receipt.resulting_state_digest is not null;

        update sync_episode_control target
        set folded_state = expected_snapshot,
            state_schema_version = 1,
            state_digest = expected_digest,
            snapshot_bytes = expected_snapshot_bytes,
            participant_event_count = repaired_participant_event_count,
            participant_event_bytes = repaired_participant_event_bytes,
            lifecycle_event_count = repaired_lifecycle_event_count,
            lifecycle_event_bytes = repaired_lifecycle_event_bytes,
            lifecycle_intent_count = repaired_lifecycle_intent_count,
            lifecycle_intent_bytes = repaired_lifecycle_intent_bytes,
            updated_at = now()
        where target.tenant_id = control.tenant_id
          and target.episode_id = control.episode_id;
    end loop;

    update sync_command_receipts receipt
    set resulting_state_digest = coalesce(
        (
            select event.resulting_state_digest
            from sync_control_events event
            where event.tenant_id = receipt.tenant_id
              and event.episode_id = receipt.episode_id
              and event.revision = receipt.resulting_revision
        ),
        case when receipt.resulting_revision = candidate.control_revision
            then candidate.state_digest
            else receipt.resulting_state_digest
        end
    )
    from sync_episode_control candidate
    where receipt.tenant_id = candidate.tenant_id
      and receipt.episode_id = candidate.episode_id
      and receipt.resulting_state_digest is not null;

    for control in
        select *
        from sync_episode_control
        where exists (
            select 1
            from sync_control_events event
            where event.tenant_id = sync_episode_control.tenant_id
              and event.episode_id = sync_episode_control.episode_id
              and event.event_schema_version = 1
        )
    loop
        select count(*)::bigint,
            coalesce(sum(
                __chalk_repair_sync_v1_receipt_bytes(
                    command_id,
                    command_name,
                    outcome,
                    rejection_reason,
                    event_id,
                    resulting_revision,
                    resulting_state_digest,
                    request_fingerprint
                )
            ), 0)::bigint
        into repaired_receipt_count, repaired_receipt_bytes
        from sync_command_receipts
        where tenant_id = control.tenant_id
          and episode_id = control.episode_id;

        update sync_episode_control target
        set receipt_count = repaired_receipt_count,
            receipt_bytes = repaired_receipt_bytes,
            updated_at = now()
        where target.tenant_id = control.tenant_id
          and target.episode_id = control.episode_id;
    end loop;
end;
$$;
-- +goose StatementEnd

drop function __chalk_repair_sync_v1_receipt_bytes(text, text, text, text, uuid, bigint, bytea, bytea);
drop function __chalk_repair_sync_v1_event_bytes(uuid, bigint, bigint, text, jsonb, text, uuid, uuid, uuid, bigint, integer, bytea);
drop function __chalk_repair_sync_v1_apply_event(jsonb, uuid, text, jsonb);
drop function __chalk_repair_sync_v1_sort_array(jsonb, text);
drop function __chalk_repair_sync_v1_valid_event_payload(text, jsonb);
drop function __chalk_repair_sync_v1_valid_role_capabilities(jsonb);
drop function __chalk_repair_sync_v1_string(jsonb, integer, integer);
drop function __chalk_repair_sync_v1_positive_integer(jsonb);
drop function __chalk_repair_sync_v1_uuid(text);
drop function __chalk_repair_sync_v1_exact_keys(jsonb, text[]);
drop function __chalk_repair_sync_v1_state_digest(jsonb);
drop function __chalk_repair_sync_v1_canonical_json(jsonb);

-- +goose Down
-- Canonical v1 digests and bytes cannot be reconstructed as the legacy v3
-- reducer output after this repair.  Refuse a rollback instead of restoring
-- a false version label or unverifiable integrity fields.
-- +goose StatementBegin
do $$
begin
    raise exception 'Sync v1 event repair is irreversible: canonical v1 payload integrity cannot return to v3';
end;
$$;
-- +goose StatementEnd
