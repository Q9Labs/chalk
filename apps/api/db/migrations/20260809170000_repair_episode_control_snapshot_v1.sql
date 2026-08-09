-- +goose Up
-- API Episode creation briefly persisted a legacy-shaped revision-zero
-- projection (`config_snapshot`) before Sync consumed the control row.  Repair
-- only that exact shape, using the immutable Episode policy and deadline.  Any
-- other revision-zero state or intent is rejected before this transaction
-- changes a durable row.

-- +goose StatementBegin
create function __chalk_repair_episode_snapshot_v1_canonical_json(value jsonb)
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
                        __chalk_repair_episode_snapshot_v1_canonical_json(entry.value),
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
                    __chalk_repair_episode_snapshot_v1_canonical_json(entry.value),
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
create function __chalk_repair_episode_snapshot_v1_state_digest(value jsonb)
returns bytea
language sql
immutable
strict
as $$
    select sha256(
        convert_to('chalk-sync-state-v1', 'UTF8')
        || int4send(1)
        || convert_to(__chalk_repair_episode_snapshot_v1_canonical_json(value), 'UTF8')
    )
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function __chalk_repair_episode_snapshot_v1_exact_keys(value jsonb, expected text[])
returns boolean
language sql
immutable
strict
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
create function __chalk_repair_episode_snapshot_v1_positive_integer(value jsonb)
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

-- Keep this validator in PL/pgSQL so malformed JSON types fail closed instead
-- of relying on planner evaluation order around jsonb_array_elements_text.
-- +goose StatementBegin
create function __chalk_repair_episode_snapshot_v1_valid_roles(roles jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    role_entry record;
    capability text;
    role_count integer;
    capability_count integer;
    distinct_capability_count integer;
begin
    if jsonb_typeof(roles) <> 'object' then
        return false;
    end if;

    select count(*) into role_count from jsonb_each(roles);
    if role_count < 1 or role_count > 16 then
        return false;
    end if;

    for role_entry in select key, value from jsonb_each(roles) loop
        if octet_length(role_entry.key) not between 1 and 64
            or role_entry.key <> btrim(role_entry.key)
            or jsonb_typeof(role_entry.value) <> 'array' then
            return false;
        end if;

        select count(*) into capability_count
        from jsonb_array_elements_text(role_entry.value);
        if capability_count > 23 then
            return false;
        end if;

        select count(distinct item) into distinct_capability_count
        from jsonb_array_elements_text(role_entry.value) item;
        if capability_count <> distinct_capability_count then
            return false;
        end if;

        for capability in select jsonb_array_elements_text(role_entry.value) loop
            if capability not in (
                'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
                'raiseHand', 'renameSelf', 'sendChat', 'sendReaction',
                'drawWhiteboard', 'manageWhiteboard', 'manageAdmission',
                'assignRoles', 'muteOthers', 'stopVideoOthers',
                'stopScreenOthers', 'requestMediaOthers', 'removeParticipant',
                'manageRecording', 'startEpisode', 'extendEpisode',
                'endEpisode', 'manageMembers', 'clearSpaceContent'
            ) then
                return false;
            end if;
        end loop;
    end loop;
    return true;
exception
    when others then
        return false;
end;
$$;
-- +goose StatementEnd

-- This is the same canonical receipt object used by Sync's
-- `ChalkSync.Stateholder.Postgres.receipt_bytes/6`.
-- +goose StatementBegin
create function __chalk_repair_episode_snapshot_v1_receipt_bytes(
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
        __chalk_repair_episode_snapshot_v1_canonical_json(
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
                        '+', '-'
                    ),
                    '/', '_'
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
    intent record;
    participant_row record;
    admission_row record;
    expected_snapshot jsonb;
    expected_digest bytea;
    expected_snapshot_bytes bigint;
    deadline_at_ms bigint;
    admission_policy text;
    repaired_intent_count bigint;
    repaired_intent_bytes bigint;
    repaired_receipt_count bigint;
    repaired_receipt_bytes bigint;
    old_shape boolean;
begin
    if to_regclass('episodes') is null
        or to_regclass('sync_episode_control') is null
        or to_regclass('sync_lifecycle_intents') is null
        or to_regclass('sync_command_receipts') is null
        or to_regclass('sync_control_events') is null then
        raise exception 'Episode v1 snapshot repair requires the Sync control schema';
    end if;

    for control in
        select candidate.*, episode.config_snapshot, episode.deadline_at,
            episode.deadline_generation
        from sync_episode_control candidate
        join episodes episode
          on episode.tenant_id = candidate.tenant_id
         and episode.space_id = candidate.space_id
         and episode.id = candidate.episode_id
        where candidate.control_revision = 0
        order by candidate.tenant_id, candidate.episode_id
        for update of candidate
    loop
        if control.deadline_at is null
            or control.deadline_at <> date_trunc('milliseconds', control.deadline_at)
            or extract(epoch from control.deadline_at) * 1000 < 1
            or control.deadline_generation < 1 then
            raise exception 'Episode v1 snapshot repair found an unsupported deadline for Episode %', control.episode_id;
        end if;

        deadline_at_ms := floor(extract(epoch from control.deadline_at) * 1000)::bigint;
        admission_policy := control.config_snapshot -> 'admission_policy' ->> 'mode';
        if admission_policy not in ('open', 'knock', 'members_only')
            or not __chalk_repair_episode_snapshot_v1_valid_roles(control.config_snapshot -> 'roles') then
            raise exception 'Episode v1 snapshot repair found an unsupported immutable policy for Episode %', control.episode_id;
        end if;

        expected_snapshot := jsonb_build_object(
            'admission_policy', admission_policy,
            'admission_requests', '[]'::jsonb,
            'control_revision', 0,
            'deadline_at_ms', deadline_at_ms,
            'deadline_generation', control.deadline_generation,
            'participants', '[]'::jsonb,
            'recording', null,
            'role_capabilities', control.config_snapshot -> 'roles',
            'state_schema_version', 1,
            'status', 'active'
        );
        expected_digest := __chalk_repair_episode_snapshot_v1_state_digest(expected_snapshot);
        expected_snapshot_bytes := octet_length(
            __chalk_repair_episode_snapshot_v1_canonical_json(
                expected_snapshot || jsonb_build_object('state_digest', encode(expected_digest, 'hex'))
            )
        );

        if exists (
            select 1
            from sync_control_events event
            where event.tenant_id = control.tenant_id
              and event.episode_id = control.episode_id
        ) then
            raise exception 'Episode v1 snapshot repair found retained events for revision-zero Episode %', control.episode_id;
        end if;

        old_shape :=
            __chalk_repair_episode_snapshot_v1_exact_keys(
                control.folded_state,
                array[
                    'admission_policy', 'admission_requests', 'config_snapshot',
                    'control_revision', 'participants', 'recording',
                    'state_schema_version', 'status'
                ]
            )
            and control.state_schema_version = 1
            and control.folded_state -> 'config_snapshot' = control.config_snapshot
            and control.folded_state -> 'admission_policy' = control.config_snapshot -> 'admission_policy'
            and control.folded_state ->> 'control_revision' = '0'
            and control.folded_state ->> 'state_schema_version' = '1'
            and control.folded_state ->> 'status' = 'active'
            and jsonb_typeof(control.folded_state -> 'admission_requests') = 'array'
            and jsonb_array_length(control.folded_state -> 'admission_requests') = 0
            and jsonb_typeof(control.folded_state -> 'participants') = 'array'
            and jsonb_array_length(control.folded_state -> 'participants') = 0
            and jsonb_typeof(control.folded_state -> 'recording') = 'null';

        if control.folded_state <> expected_snapshot and not old_shape then
            raise exception 'Episode v1 snapshot repair found an unsupported revision-zero snapshot for Episode %', control.episode_id;
        end if;

        if control.folded_state = expected_snapshot
            and control.state_schema_version = 1
            and control.state_digest = expected_digest
            and control.snapshot_bytes = expected_snapshot_bytes
            and not exists (
                select 1
                from sync_lifecycle_intents intent_row
                where intent_row.tenant_id = control.tenant_id
                  and intent_row.episode_id = control.episode_id
                  and intent_row.status = 'pending'
                  and intent_row.last_error_code is not null
            ) then
            continue;
        end if;

        -- Validate pending intents before clearing their stale invalid_state
        -- retry marker.  No unsupported intent is made runnable by this repair.
        for intent in
            select intent_row.*
            from sync_lifecycle_intents intent_row
            where intent_row.tenant_id = control.tenant_id
              and intent_row.episode_id = control.episode_id
            order by intent_row.created_at, intent_row.lifecycle_intent_id
        loop
            if intent.status <> 'pending'
                or (intent.last_error_code is not null and intent.last_error_code <> 'invalid_state') then
                raise exception 'Episode v1 snapshot repair found a non-retryable lifecycle intent % for Episode %', intent.lifecycle_intent_id, control.episode_id;
            end if;

            if intent.intent_name = 'participant_joined' then
                if intent.participant_id is null
                    or intent.participant_generation is null
                    or not __chalk_repair_episode_snapshot_v1_exact_keys(
                        intent.payload,
                        array['display_name', 'participant_id', 'role']
                    )
                    or not __chalk_repair_episode_snapshot_v1_positive_integer(
                        to_jsonb(intent.participant_generation)
                    )
                    or intent.payload ->> 'participant_id' is null
                    or intent.payload ->> 'participant_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or intent.payload ->> 'display_name' is null
                    or octet_length(intent.payload ->> 'display_name') not between 1 and 256
                    or intent.payload ->> 'display_name' <> btrim(intent.payload ->> 'display_name')
                    or intent.payload ->> 'role' is null
                    or octet_length(intent.payload ->> 'role') not between 1 and 64
                    or intent.payload ->> 'role' <> btrim(intent.payload ->> 'role')
                    or not (control.config_snapshot -> 'roles') ? (intent.payload ->> 'role') then
                    raise exception 'Episode v1 snapshot repair found an unsupported participant_joined intent %', intent.lifecycle_intent_id;
                end if;

                select participant.*
                into participant_row
                from participants participant
                where participant.tenant_id = control.tenant_id
                  and participant.space_id = control.space_id
                  and participant.episode_id = control.episode_id
                  and participant.id = intent.participant_id;
                if not found
                    or participant_row.generation <> intent.participant_generation
                    or participant_row.status <> 'joining'
                    or participant_row.name is distinct from intent.payload ->> 'display_name'
                    or participant_row.role is distinct from intent.payload ->> 'role' then
                    raise exception 'Episode v1 snapshot repair found an unsupported participant_joined product row for intent %', intent.lifecycle_intent_id;
                end if;
            elsif intent.intent_name = 'admission_requested' then
                if intent.participant_id is not null
                    or not __chalk_repair_episode_snapshot_v1_exact_keys(
                        intent.payload,
                        array[
                            'admission_request_id', 'display_name', 'expires_at_ms',
                            'participant_id', 'role'
                        ]
                    )
                    or intent.payload -> 'expires_at_ms' is null
                    or not coalesce(__chalk_repair_episode_snapshot_v1_positive_integer(intent.payload -> 'expires_at_ms'), false)
                    or intent.payload ->> 'admission_request_id' is null
                    or intent.payload ->> 'admission_request_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or intent.payload ->> 'display_name' is null
                    or octet_length(intent.payload ->> 'display_name') not between 1 and 256
                    or intent.payload ->> 'display_name' <> btrim(intent.payload ->> 'display_name')
                    or intent.payload ->> 'participant_id' is null
                    or intent.payload ->> 'participant_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                    or intent.payload ->> 'role' is null
                    or octet_length(intent.payload ->> 'role') not between 1 and 64
                    or intent.payload ->> 'role' <> btrim(intent.payload ->> 'role')
                    or not (control.config_snapshot -> 'roles') ? (intent.payload ->> 'role') then
                    raise exception 'Episode v1 snapshot repair found an unsupported admission_requested intent %', intent.lifecycle_intent_id;
                end if;

                select admission.*
                into admission_row
                from sync_admission_requests admission
                where admission.tenant_id = control.tenant_id
                  and admission.space_id = control.space_id
                  and admission.episode_id = control.episode_id
                  and admission.admission_request_id = (intent.payload ->> 'admission_request_id')::uuid;
                if not found
                    or admission_row.status <> 'pending'
                    or admission_row.participant_id::text is distinct from intent.payload ->> 'participant_id'
                    or admission_row.display_name is distinct from intent.payload ->> 'display_name'
                    or admission_row.role is distinct from intent.payload ->> 'role'
                    or floor(extract(epoch from admission_row.expires_at) * 1000)::bigint <> (intent.payload ->> 'expires_at_ms')::bigint then
                    raise exception 'Episode v1 snapshot repair found an unsupported admission_requested product row for intent %', intent.lifecycle_intent_id;
                end if;
            else
                raise exception 'Episode v1 snapshot repair found unsupported lifecycle intent %', intent.intent_name;
            end if;
        end loop;

        if exists (
            select 1
            from sync_command_receipts receipt
            where receipt.tenant_id = control.tenant_id
              and receipt.episode_id = control.episode_id
              and receipt.resulting_revision is not null
              and receipt.resulting_revision > 0
        ) then
            raise exception 'Episode v1 snapshot repair found a receipt beyond revision zero for Episode %', control.episode_id;
        end if;

        update sync_command_receipts receipt
        set resulting_state_digest = expected_digest
        where receipt.tenant_id = control.tenant_id
          and receipt.episode_id = control.episode_id
          and receipt.resulting_revision = 0
          and receipt.resulting_state_digest is not null;

        select count(*)::bigint,
            coalesce(sum(octet_length(payload::text)), 0)::bigint
        into repaired_intent_count, repaired_intent_bytes
        from sync_lifecycle_intents
        where tenant_id = control.tenant_id
          and episode_id = control.episode_id;

        select count(*)::bigint,
            coalesce(sum(
                __chalk_repair_episode_snapshot_v1_receipt_bytes(
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

        update sync_lifecycle_intents
        set last_error_code = null,
            next_attempt_at = now()
        where tenant_id = control.tenant_id
          and episode_id = control.episode_id
          and status = 'pending';

        update sync_episode_control target
        set folded_state = expected_snapshot,
            state_schema_version = 1,
            state_digest = expected_digest,
            snapshot_bytes = expected_snapshot_bytes,
            participant_event_count = 0,
            participant_event_bytes = 0,
            lifecycle_event_count = 0,
            lifecycle_event_bytes = 0,
            lifecycle_intent_count = repaired_intent_count,
            lifecycle_intent_bytes = repaired_intent_bytes,
            receipt_count = repaired_receipt_count,
            receipt_bytes = repaired_receipt_bytes,
            updated_at = now()
        where target.tenant_id = control.tenant_id
          and target.episode_id = control.episode_id;
    end loop;
end;
$$;
-- +goose StatementEnd

drop function __chalk_repair_episode_snapshot_v1_receipt_bytes(text, text, text, text, uuid, bigint, bytea, bytea);
drop function __chalk_repair_episode_snapshot_v1_valid_roles(jsonb);
drop function __chalk_repair_episode_snapshot_v1_positive_integer(jsonb);
drop function __chalk_repair_episode_snapshot_v1_exact_keys(jsonb, text[]);
drop function __chalk_repair_episode_snapshot_v1_state_digest(jsonb);
drop function __chalk_repair_episode_snapshot_v1_canonical_json(jsonb);

-- +goose Down
-- The previous bytes/digest and retry markers are not recoverable from the
-- repaired rows.  Refuse a false rollback rather than restoring unverifiable
-- control authority.
-- +goose StatementBegin
do $$
begin
    raise exception 'Episode v1 snapshot repair is irreversible: canonical control integrity cannot return to the malformed API shape';
end;
$$;
-- +goose StatementEnd
