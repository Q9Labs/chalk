-- +goose Up
alter table sync_session_control
    drop constraint sync_session_control_retention_checkpoint_check,
    add column retention_deleted_external_operation_rows bigint not null default 0,
    add column retention_deleted_external_operation_bytes bigint not null default 0,
    add column retention_deleted_admission_request_rows bigint not null default 0,
    add column retention_deleted_admission_request_bytes bigint not null default 0,
    add column retention_deleted_recording_rows bigint not null default 0,
    add column retention_deleted_recording_bytes bigint not null default 0,
    add column retention_deleted_screen_share_lease_rows bigint not null default 0,
    add column retention_deleted_screen_share_lease_bytes bigint not null default 0,
    add column retention_deleted_publication_fence_rows bigint not null default 0,
    add column retention_deleted_publication_fence_bytes bigint not null default 0,
    add column retention_deleted_publication_grant_reservation_rows bigint not null default 0,
    add column retention_deleted_publication_grant_reservation_bytes bigint not null default 0,
    add constraint sync_session_control_retention_checkpoint_check
        check (
            (
                retention_cleaned_at is null
                and retention_checkpoint_revision is null
                and retention_checkpoint_state_digest is null
                and retention_checkpoint_event_count is null
                and retention_deleted_event_rows = 0
                and retention_deleted_event_bytes = 0
                and retention_deleted_receipt_rows = 0
                and retention_deleted_receipt_bytes = 0
                and retention_deleted_lifecycle_intent_rows = 0
                and retention_deleted_lifecycle_intent_bytes = 0
                and retention_deleted_external_operation_rows = 0
                and retention_deleted_external_operation_bytes = 0
                and retention_deleted_admission_request_rows = 0
                and retention_deleted_admission_request_bytes = 0
                and retention_deleted_recording_rows = 0
                and retention_deleted_recording_bytes = 0
                and retention_deleted_screen_share_lease_rows = 0
                and retention_deleted_screen_share_lease_bytes = 0
                and retention_deleted_publication_fence_rows = 0
                and retention_deleted_publication_fence_bytes = 0
                and retention_deleted_publication_grant_reservation_rows = 0
                and retention_deleted_publication_grant_reservation_bytes = 0
            )
            or (
                retention_cleaned_at is not null
                and retention_checkpoint_revision is not null
                and retention_checkpoint_revision >= 0
                and retention_checkpoint_state_digest is not null
                and octet_length(retention_checkpoint_state_digest) = 32
                and retention_checkpoint_event_count is not null
                and retention_checkpoint_event_count = retention_checkpoint_revision
                and retention_deleted_event_rows = retention_checkpoint_event_count
                and retention_deleted_event_bytes >= 0
                and retention_deleted_receipt_rows >= 0
                and retention_deleted_receipt_bytes >= 0
                and retention_deleted_lifecycle_intent_rows >= 0
                and retention_deleted_lifecycle_intent_bytes >= 0
                and retention_deleted_external_operation_rows >= 0
                and retention_deleted_external_operation_bytes >= 0
                and retention_deleted_admission_request_rows >= 0
                and retention_deleted_admission_request_bytes >= 0
                and retention_deleted_recording_rows >= 0
                and retention_deleted_recording_bytes >= 0
                and retention_deleted_screen_share_lease_rows >= 0
                and retention_deleted_screen_share_lease_bytes >= 0
                and retention_deleted_publication_fence_rows >= 0
                and retention_deleted_publication_fence_bytes >= 0
                and retention_deleted_publication_grant_reservation_rows >= 0
                and retention_deleted_publication_grant_reservation_bytes >= 0
            )
        );

-- +goose StatementBegin
create function sync_v3_valid_role_capabilities(value jsonb)
returns boolean
language plpgsql
immutable
strict
as $$
declare
    role_name text;
    capability_value jsonb;
    capability_name text;
    seen text[];
    allowed constant text[] := array[
        'publishAudio', 'publishVideo', 'publishScreen', 'subscribe',
        'raiseHand', 'renameSelf', 'manageAdmission', 'promoteDemote',
        'transferHost', 'muteOthers', 'stopVideoOthers', 'stopScreenOthers',
        'requestMediaOthers', 'removeParticipant', 'manageRecording', 'endMeeting'
    ];
begin
    if jsonb_typeof(value) <> 'object'
        or not value ?& array['host', 'cohost', 'participant']
        or (select count(*) from jsonb_object_keys(value)) <> 3 then
        return false;
    end if;

    foreach role_name in array array['host', 'cohost', 'participant'] loop
        capability_value := value -> role_name;
        if jsonb_typeof(capability_value) <> 'array' or jsonb_array_length(capability_value) > 16 then
            return false;
        end if;

        seen := array[]::text[];
        for capability_name in select jsonb_array_elements_text(capability_value) loop
            if not capability_name = any(allowed) or capability_name = any(seen) then
                return false;
            end if;
            seen := array_append(seen, capability_name);
        end loop;
    end loop;

    return true;
exception
    when others then
        return false;
end;
$$;
-- +goose StatementEnd

-- +goose StatementBegin
create function sync_v3_valid_eligible_roles(value text[])
returns boolean
language sql
immutable
strict
as $$
    select cardinality(value) between 1 and 3
        and value <@ array['host', 'cohost', 'participant']::text[]
        and cardinality(value) = (select count(distinct role_name) from unnest(value) as role_name)
$$;
-- +goose StatementEnd

alter table room_sessions
    add column host_exit_policy text not null default 'require_transfer',
    add column role_capabilities jsonb not null default '{"host":["publishAudio","publishVideo","publishScreen","subscribe","raiseHand","renameSelf","manageAdmission","promoteDemote","transferHost","muteOthers","stopVideoOthers","stopScreenOthers","requestMediaOthers","removeParticipant","manageRecording","endMeeting"],"cohost":["publishAudio","publishVideo","publishScreen","subscribe","raiseHand","renameSelf","manageAdmission","promoteDemote","muteOthers","stopVideoOthers","stopScreenOthers","requestMediaOthers","removeParticipant","manageRecording"],"participant":["publishAudio","publishVideo","publishScreen","subscribe","raiseHand","renameSelf"]}'::jsonb,
    add column maximum_duration_seconds integer not null default 86400,
    add column maximum_duration_ceiling_seconds integer not null default 86400,
    add column deadline_at timestamptz,
    add column deadline_generation bigint not null default 1;

update room_sessions
set deadline_at = created_at + interval '24 hours';

alter table room_sessions
    alter column deadline_at set default (now() + interval '24 hours'),
    alter column deadline_at set not null,
    add constraint room_sessions_sync_v3_host_exit_policy_check
        check (host_exit_policy in ('require_transfer', 'promote_cohost')),
    add constraint room_sessions_sync_v3_role_capabilities_check
        check (sync_v3_valid_role_capabilities(role_capabilities)),
    add constraint room_sessions_sync_v3_duration_check
        check (
            maximum_duration_seconds between 60 and 604800
            and maximum_duration_ceiling_seconds between 60 and 604800
            and maximum_duration_seconds <= maximum_duration_ceiling_seconds
            and deadline_generation > 0
            and deadline_at <= created_at + make_interval(secs => maximum_duration_ceiling_seconds)
        );

-- +goose StatementBegin
create function sync_v3_protect_immutable_session_policy()
returns trigger
language plpgsql
as $$
begin
    if new.host_exit_policy is distinct from old.host_exit_policy
        or new.role_capabilities is distinct from old.role_capabilities
        or new.maximum_duration_ceiling_seconds is distinct from old.maximum_duration_ceiling_seconds then
        raise exception 'sync v3 immutable Session policy cannot change';
    end if;

    if new.deadline_at is distinct from old.deadline_at
        or new.maximum_duration_seconds is distinct from old.maximum_duration_seconds then
        if new.deadline_generation <> old.deadline_generation + 1 then
            raise exception 'sync v3 deadline mutation must advance generation exactly once';
        end if;
    elsif new.deadline_generation is distinct from old.deadline_generation then
        raise exception 'sync v3 deadline generation cannot change without a deadline mutation';
    end if;

    return new;
end;
$$;
-- +goose StatementEnd

create trigger room_sessions_sync_v3_immutable_policy
before update on room_sessions
for each row execute function sync_v3_protect_immutable_session_policy();

alter table participants
    add column role text not null default 'participant',
    add column eligible_roles text[] not null default array['participant']::text[],
    add constraint participants_sync_v3_generation_key
        unique (tenant_id, room_id, session_id, id, generation),
    add constraint participants_sync_v3_role_check
        check (role in ('host', 'cohost', 'participant')),
    add constraint participants_sync_v3_eligible_roles_check
        check (
            sync_v3_valid_eligible_roles(eligible_roles)
            and role = any(eligible_roles)
            and (role <> 'host' or 'cohost' = any(eligible_roles))
        );

create unique index participants_sync_v3_one_host_per_session_idx
    on participants(tenant_id, session_id)
    where role = 'host' and status in ('joining', 'active', 'leaving');

alter table sync_lifecycle_intents
    drop constraint sync_lifecycle_intents_target_check,
    add constraint sync_lifecycle_intents_sync_v3_target_check
        check (
            (
                intent_name in ('participant_joined', 'participant_left')
                and participant_session_id is not null
                and participant_session_generation > 0
            )
            or (
                intent_name in ('session_ended', 'admission_requested')
                and participant_session_id is null
                and participant_session_generation is null
            )
        );

alter table sync_lifecycle_intents
    add constraint sync_lifecycle_intents_sync_v3_generation_fkey
        foreign key (
            tenant_id, room_id, session_id,
            participant_session_id, participant_session_generation
        )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict;

alter table sync_control_events
    add constraint sync_control_events_sync_v3_actor_generation_fkey
        foreign key (
            tenant_id, room_id, session_id,
            actor_participant_session_id, actor_generation
        )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict;

alter table sync_session_control
    add column host_participant_session_id uuid,
    add constraint sync_session_control_sync_v3_host_fkey
        foreign key (tenant_id, room_id, session_id, host_participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict
        deferrable initially deferred;

alter table sync_control_events
    drop constraint sync_control_events_origin_check,
    add column external_operation_id uuid,
    add constraint sync_control_events_sync_v3_origin_check
        check (
            num_nonnulls(command_id, lifecycle_intent_id, external_operation_id) = 1
            and (
                (
                    command_id is not null
                    and command_id ~ '^[A-Za-z0-9_-]{16,64}$'
                    and actor_participant_session_id is not null
                    and actor_generation > 0
                )
                or (
                    lifecycle_intent_id is not null
                    and actor_participant_session_id is null
                    and actor_generation is null
                )
                or (
                    external_operation_id is not null
                    and (actor_participant_session_id is null) = (actor_generation is null)
                    and (actor_generation is null or actor_generation > 0)
                )
            )
        ),
    add constraint sync_control_events_sync_v3_external_event_key
        unique (tenant_id, session_id, external_operation_id, event_id, revision),
    add constraint sync_control_events_sync_v3_receipt_event_key
        unique (tenant_id, session_id, event_id, revision);

alter table sync_command_receipts
    drop constraint sync_command_receipts_committed_event_fkey,
    drop constraint sync_command_receipts_command_name_check,
    drop constraint sync_command_receipts_outcome_check,
    add column resulting_state_digest bytea,
    add column external_operation_id uuid,
    add column completed_at timestamptz,
    add constraint sync_command_receipts_sync_v3_command_name_check
        check (command_name in (
            'raise_hand',
            'lower_hand',
            'set_hand_raised',
            'set_display_name',
            'set_admission_policy',
            'set_participant_role',
            'transfer_host',
            'admit_participant',
            'deny_admission',
            'mute_participant',
            'stop_participant_camera',
            'stop_participant_screen_share',
            'remove_participant',
            'start_recording',
            'stop_recording',
            'participant_leave',
            'end_session'
        )),
    add constraint sync_command_receipts_sync_v3_outcome_check
        check (
            (
                command_name in ('raise_hand', 'lower_hand')
                and resulting_state_digest is null
                and external_operation_id is null
                and completed_at is null
                and (
                    (
                        outcome = 'committed'
                        and rejection_reason is null
                        and event_id is not null
                        and resulting_revision > 0
                    )
                    or (
                        outcome = 'rejected'
                        and rejection_reason in (
                            'session_ended',
                            'participant_inactive',
                            'stale_participant_generation',
                            'capability_denied',
                            'invalid_state',
                            'command_id_conflict'
                        )
                        and event_id is null
                        and resulting_revision is null
                    )
                )
            )
            or (
                command_name in (
                    'set_hand_raised',
                    'set_display_name',
                    'set_admission_policy',
                    'set_participant_role',
                    'transfer_host',
                    'admit_participant',
                    'deny_admission',
                    'mute_participant',
                    'stop_participant_camera',
                    'stop_participant_screen_share',
                    'remove_participant',
                    'start_recording',
                    'stop_recording',
                    'participant_leave',
                    'end_session'
                )
                and (
                    (
                        outcome = 'committed'
                        and rejection_reason is null
                        and event_id is not null
                        and resulting_revision > 0
                        and octet_length(resulting_state_digest) = 32
                        and completed_at is not null
                    )
                    or (
                        outcome = 'satisfied'
                        and rejection_reason is null
                        and event_id is null
                        and resulting_revision >= 0
                        and octet_length(resulting_state_digest) = 32
                        and external_operation_id is null
                        and completed_at is not null
                    )
                    or (
                        outcome = 'pending'
                        and rejection_reason is null
                        and external_operation_id is not null
                        and completed_at is null
                        and (
                            (
                                command_name in ('set_participant_role', 'transfer_host')
                                and event_id is not null
                                and resulting_revision > 0
                                and octet_length(resulting_state_digest) = 32
                            )
                            or (
                                command_name not in ('set_participant_role', 'transfer_host')
                                and event_id is null
                                and resulting_revision is null
                                and resulting_state_digest is null
                            )
                        )
                    )
                    or (
                        outcome = 'rejected'
                        and rejection_reason in (
                            'session_ended',
                            'participant_inactive',
                            'stale_participant_generation',
                            'capability_denied',
                            'invalid_state',
                            'invalid_target',
                            'role_not_eligible',
                            'host_transfer_required',
                            'screen_share_in_use',
                            'recording_in_progress',
                            'external_operation_failed'
                        )
                        and completed_at is not null
                        and (
                            (
                                command_name in ('set_participant_role', 'transfer_host')
                                and external_operation_id is not null
                                and event_id is not null
                                and resulting_revision > 0
                                and octet_length(resulting_state_digest) = 32
                            )
                            or (
                                command_name not in ('set_participant_role', 'transfer_host')
                                and event_id is null
                                and resulting_revision is null
                                and resulting_state_digest is null
                            )
                        )
                    )
                )
            )
        ),
    add constraint sync_command_receipts_sync_v3_event_fkey
        foreign key (
            tenant_id,
            session_id,
            event_id,
            resulting_revision
        )
        references sync_control_events(
            tenant_id,
            session_id,
            event_id,
            revision
        )
        on delete restrict
        deferrable initially deferred;

create table sync_external_operations (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    external_operation_id uuid primary key,
    parent_external_operation_id uuid,
    request_key text not null,
    request_fingerprint bytea not null,
    operation_name text not null,
    actor_participant_session_id uuid,
    actor_generation bigint,
    target_participant_session_id uuid,
    target_participant_generation bigint,
    source text,
    recording_id uuid,
    deadline_generation bigint,
    journey_id uuid,
    parent_journey_event_id uuid,
    producing_trace_id text,
    producing_span_id text,
    payload jsonb not null,
    status text not null default 'pending',
    fence_active boolean not null default false,
    attempt_count integer not null default 0,
    next_attempt_at timestamptz not null default now(),
    last_error_code text,
    applied_event_id uuid,
    applied_revision bigint,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, room_id, session_id, external_operation_id),
    unique (tenant_id, session_id, external_operation_id),
    unique (tenant_id, session_id, operation_name, request_key),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (
        tenant_id, room_id, session_id,
        actor_participant_session_id, actor_generation
    )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    foreign key (
        tenant_id, room_id, session_id,
        target_participant_session_id, target_participant_generation
    )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(payload::text) <= 16384),
    check (operation_name in (
        'admit_participant', 'deny_admission', 'admission_request_expired', 'mute_participant',
        'stop_participant_camera', 'stop_participant_screen_share',
        'remove_participant', 'start_recording', 'stop_recording',
        'participant_leave', 'end_session', 'tenant_transfer_host', 'tenant_set_deadline',
        'tenant_end_session', 'maximum_duration_expired',
        'role_transition_cleanup', 'role_transition_source_stop'
    )),
    check (source is null or source in ('microphone', 'camera', 'screen')),
    check ((actor_participant_session_id is null) = (actor_generation is null)),
    check (actor_generation is null or actor_generation > 0),
    check ((target_participant_session_id is null) = (target_participant_generation is null)),
    check (target_participant_generation is null or target_participant_generation > 0),
    check (deadline_generation is null or deadline_generation > 0),
    check (
        (operation_name in ('tenant_set_deadline', 'maximum_duration_expired'))
        = (deadline_generation is not null)
    ),
    check ((journey_id is null) = (parent_journey_event_id is null)),
    check (producing_trace_id is null or producing_trace_id ~ '^[0-9a-f]{32}$'),
    check (producing_span_id is null or producing_span_id ~ '^[0-9a-f]{16}$'),
    check ((producing_trace_id is null) = (producing_span_id is null)),
    check (attempt_count between 0 and 100),
    check (
        (operation_name = 'role_transition_cleanup' and parent_external_operation_id is null and source is null)
        or (operation_name = 'role_transition_source_stop' and parent_external_operation_id is not null and source is not null)
        or (operation_name not in ('role_transition_cleanup', 'role_transition_source_stop') and parent_external_operation_id is null)
    ),
    check (
        (
            status = 'pending'
            and completed_at is null
            and applied_event_id is null
            and applied_revision is null
        )
        or (
            status = 'applied'
            and completed_at is not null
            and last_error_code is null
            and ((applied_event_id is null and applied_revision is null) or (applied_event_id is not null and applied_revision > 0))
            and fence_active = false
        )
        or (
            status = 'failed'
            and completed_at is not null
            and last_error_code is not null
            and applied_event_id is null
            and applied_revision is null
        )
    )
);

alter table sync_external_operations
    add constraint sync_external_operations_parent_fkey
        foreign key (tenant_id, session_id, parent_external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict;

create unique index sync_external_operations_parent_source_key
    on sync_external_operations(tenant_id, session_id, parent_external_operation_id, source)
    where parent_external_operation_id is not null;

create index sync_external_operations_pending_idx
    on sync_external_operations(next_attempt_at, external_operation_id)
    where status = 'pending';

alter table sync_control_events
    add constraint sync_control_events_external_operation_fkey
        foreign key (tenant_id, session_id, external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict;

alter table sync_external_operations
    add constraint sync_external_operations_applied_event_fkey
        foreign key (tenant_id, session_id, external_operation_id, applied_event_id, applied_revision)
        references sync_control_events(tenant_id, session_id, external_operation_id, event_id, revision)
        on delete restrict;

alter table sync_command_receipts
    add constraint sync_command_receipts_external_operation_fkey
        foreign key (tenant_id, session_id, external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict;

create table sync_admission_requests (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    admission_request_id uuid primary key,
    request_key text not null,
    request_fingerprint bytea not null,
    participant_session_id uuid not null,
    display_name text not null,
    initial_role text not null,
    eligible_roles text[] not null,
    status text not null default 'pending',
    decision_external_operation_id uuid,
    requested_at timestamptz not null default now(),
    expires_at timestamptz not null,
    completed_at timestamptz,
    unique (tenant_id, room_id, session_id, admission_request_id),
    unique (tenant_id, session_id, request_key),
    unique (tenant_id, session_id, participant_session_id),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (tenant_id, session_id, decision_external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32),
    check (octet_length(display_name) between 1 and 256 and display_name = btrim(display_name)),
    check (initial_role in ('host', 'cohost', 'participant')),
    check (
        sync_v3_valid_eligible_roles(eligible_roles)
        and initial_role = any(eligible_roles)
        and (initial_role <> 'host' or 'cohost' = any(eligible_roles))
    ),
    check (expires_at > requested_at),
    check (
        (status = 'pending' and completed_at is null)
        or (status in ('admitted', 'denied', 'expired') and decision_external_operation_id is not null and completed_at is not null)
    )
);

create index sync_admission_requests_pending_idx
    on sync_admission_requests(expires_at, admission_request_id)
    where status = 'pending';

create table sync_screen_share_leases (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    lease_id uuid not null unique,
    owner_participant_session_id uuid not null,
    owner_generation bigint not null,
    lease_generation bigint not null,
    status text not null,
    acquired_at timestamptz not null,
    renewed_until timestamptz not null,
    hard_expires_at timestamptz not null,
    primary key (tenant_id, session_id),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (
        tenant_id, room_id, session_id,
        owner_participant_session_id, owner_generation
    )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    check (owner_generation > 0 and lease_generation > 0),
    check (status in ('acquiring', 'active')),
    check (acquired_at < renewed_until and renewed_until <= hard_expires_at)
);

create index sync_screen_share_leases_expiry_idx
    on sync_screen_share_leases(hard_expires_at, lease_id);

create table sync_publication_fences (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    external_operation_id uuid not null,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, participant_session_id, source),
    foreign key (
        tenant_id, room_id, session_id,
        participant_session_id, participant_generation
    )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, session_id, external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict,
    check (source in ('microphone', 'camera', 'screen')),
    check (participant_generation > 0),
    check (expires_at > created_at)
);

create index sync_publication_fences_expiry_idx
    on sync_publication_fences(expires_at, external_operation_id);

create table sync_publication_grant_reservations (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    reservation_id uuid primary key,
    operation_id text not null,
    participant_session_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    status text not null default 'pending',
    failure_code text,
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, session_id, operation_id),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (
        tenant_id, room_id, session_id,
        participant_session_id, participant_generation
    ) references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    check (operation_id ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (status in ('pending', 'confirmed', 'failed', 'ambiguous')),
    check (expires_at > created_at),
    check (
        (status in ('pending', 'ambiguous') and completed_at is null)
        or (status = 'confirmed' and failure_code is null and completed_at is not null)
        or (status = 'failed' and failure_code is not null and completed_at is not null)
    )
);

create unique index sync_publication_grant_reservations_active_source_key
    on sync_publication_grant_reservations(tenant_id, session_id, participant_session_id, source)
    where status in ('pending', 'ambiguous');

create index sync_publication_grant_reservations_expiry_idx
    on sync_publication_grant_reservations(expires_at, reservation_id);

create table sync_recordings (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    recording_id uuid primary key,
    status text not null,
    generation bigint not null,
    adapter_metadata jsonb not null default '{}'::jsonb,
    started_by_participant_session_id uuid,
    started_by_generation bigint,
    start_external_operation_id uuid not null,
    stop_external_operation_id uuid,
    failure_code text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, room_id, session_id, recording_id),
    foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    foreign key (
        tenant_id, room_id, session_id,
        started_by_participant_session_id, started_by_generation
    )
        references participants(tenant_id, room_id, session_id, id, generation)
        on delete restrict,
    foreign key (tenant_id, session_id, start_external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict,
    foreign key (tenant_id, session_id, stop_external_operation_id)
        references sync_external_operations(tenant_id, session_id, external_operation_id)
        on delete restrict,
    check (status in ('starting', 'recording', 'stopping', 'stopped', 'failed')),
    check (generation > 0),
    check ((started_by_participant_session_id is null) = (started_by_generation is null)),
    check (started_by_generation is null or started_by_generation > 0),
    check (
        (status in ('starting', 'recording', 'stopping') and completed_at is null and failure_code is null)
        or (status = 'stopped' and completed_at is not null and failure_code is null)
        or (status = 'failed' and completed_at is not null and failure_code is not null)
    )
);

create unique index sync_recordings_one_active_per_session_idx
    on sync_recordings(tenant_id, session_id)
    where status in ('starting', 'recording', 'stopping');

-- A committed receipt may point at a command event, an external-operation
-- event, or (for admission approval only) the linked Participant lifecycle
-- event. The generic event FK proves the referenced head exists; this deferred
-- trigger proves that the event belongs to the receipt's durable origin.
-- +goose StatementBegin
create function sync_v3_validate_receipt_event_origin()
returns trigger
language plpgsql
as $$
declare
    event_row sync_control_events%rowtype;
begin
    if new.outcome <> 'committed' then
        return new;
    end if;

    select *
    into event_row
    from sync_control_events
    where tenant_id = new.tenant_id
      and session_id = new.session_id
      and event_id = new.event_id
      and revision = new.resulting_revision;

    if not found then
        raise exception 'committed sync receipt references a missing event';
    end if;

    if event_row.command_id = new.command_id
        and event_row.actor_participant_session_id = new.participant_session_id
        and event_row.actor_generation = new.submitted_generation then
        return new;
    end if;

    if new.external_operation_id is not null
        and event_row.external_operation_id = new.external_operation_id then
        return new;
    end if;

    if new.command_name = 'admit_participant'
        and new.external_operation_id is not null
        and event_row.event_name = 'participant_joined'
        and event_row.lifecycle_intent_id is not null
        and exists (
            select 1
            from sync_admission_requests admission
            where admission.tenant_id = new.tenant_id
              and admission.session_id = new.session_id
              and admission.decision_external_operation_id = new.external_operation_id
              and admission.status = 'admitted'
              and admission.participant_session_id::text =
                  event_row.payload ->> 'participant_session_id'
        ) then
        return new;
    end if;

    raise exception 'committed sync receipt event origin does not match its durable request';
end;
$$;
-- +goose StatementEnd

create constraint trigger sync_command_receipts_sync_v3_event_origin
after insert or update on sync_command_receipts
deferrable initially deferred
for each row execute function sync_v3_validate_receipt_event_origin();

-- +goose Down
-- V3 policy, satisfied receipts, and external-operation rows cannot be
-- represented by the unpublished v2 schema. Rollback is safe only before any
-- Session has used v3 authority; fail explicitly instead of dropping data.
-- +goose StatementBegin
do $$
begin
    if exists (select 1 from sync_session_control) then
        raise exception 'cannot roll back declarative sync v3 after Session authority has been created';
    end if;
end;
$$;
-- +goose StatementEnd

alter table sync_session_control
    drop constraint sync_session_control_retention_checkpoint_check,
    drop column retention_deleted_publication_grant_reservation_bytes,
    drop column retention_deleted_publication_grant_reservation_rows,
    drop column retention_deleted_publication_fence_bytes,
    drop column retention_deleted_publication_fence_rows,
    drop column retention_deleted_screen_share_lease_bytes,
    drop column retention_deleted_screen_share_lease_rows,
    drop column retention_deleted_recording_bytes,
    drop column retention_deleted_recording_rows,
    drop column retention_deleted_admission_request_bytes,
    drop column retention_deleted_admission_request_rows,
    drop column retention_deleted_external_operation_bytes,
    drop column retention_deleted_external_operation_rows,
    add constraint sync_session_control_retention_checkpoint_check
        check (
            (
                retention_cleaned_at is null
                and retention_checkpoint_revision is null
                and retention_checkpoint_state_digest is null
                and retention_checkpoint_event_count is null
                and retention_deleted_event_rows = 0
                and retention_deleted_event_bytes = 0
                and retention_deleted_receipt_rows = 0
                and retention_deleted_receipt_bytes = 0
                and retention_deleted_lifecycle_intent_rows = 0
                and retention_deleted_lifecycle_intent_bytes = 0
            )
            or (
                retention_cleaned_at is not null
                and retention_checkpoint_revision is not null
                and retention_checkpoint_revision >= 0
                and retention_checkpoint_state_digest is not null
                and octet_length(retention_checkpoint_state_digest) = 32
                and retention_checkpoint_event_count is not null
                and retention_checkpoint_event_count = retention_checkpoint_revision
                and retention_deleted_event_rows = retention_checkpoint_event_count
                and retention_deleted_event_bytes >= 0
                and retention_deleted_receipt_rows >= 0
                and retention_deleted_receipt_bytes >= 0
                and retention_deleted_lifecycle_intent_rows >= 0
                and retention_deleted_lifecycle_intent_bytes >= 0
            )
        );

drop trigger sync_command_receipts_sync_v3_event_origin on sync_command_receipts;
drop function sync_v3_validate_receipt_event_origin();

drop index sync_recordings_one_active_per_session_idx;
drop table sync_recordings;
drop index sync_publication_fences_expiry_idx;
drop table sync_publication_fences;
drop index sync_publication_grant_reservations_expiry_idx;
drop index sync_publication_grant_reservations_active_source_key;
drop table sync_publication_grant_reservations;
drop index sync_screen_share_leases_expiry_idx;
drop table sync_screen_share_leases;
drop index sync_admission_requests_pending_idx;
drop table sync_admission_requests;

alter table sync_command_receipts
    drop constraint sync_command_receipts_external_operation_fkey;

alter table sync_external_operations
    drop constraint sync_external_operations_applied_event_fkey;

alter table sync_control_events
    drop constraint sync_control_events_external_operation_fkey;

drop index sync_external_operations_pending_idx;
drop index sync_external_operations_parent_source_key;
alter table sync_external_operations
    drop constraint sync_external_operations_parent_fkey;
drop table sync_external_operations;

alter table sync_command_receipts
    drop constraint sync_command_receipts_sync_v3_event_fkey,
    drop constraint sync_command_receipts_sync_v3_outcome_check,
    drop constraint sync_command_receipts_sync_v3_command_name_check,
    drop column completed_at,
    drop column external_operation_id,
    drop column resulting_state_digest,
    add constraint sync_command_receipts_command_name_check
        check (command_name in ('raise_hand', 'lower_hand')),
    add constraint sync_command_receipts_outcome_check
        check (
            (
                outcome = 'committed'
                and rejection_reason is null
                and event_id is not null
                and resulting_revision > 0
            )
            or (
                outcome = 'rejected'
                and rejection_reason in (
                    'session_ended', 'participant_inactive',
                    'stale_participant_generation', 'capability_denied',
                    'invalid_state', 'command_id_conflict'
                )
                and event_id is null
                and resulting_revision is null
            )
        ),
    add constraint sync_command_receipts_committed_event_fkey
        foreign key (
            tenant_id, session_id, participant_session_id,
            submitted_generation, command_id, event_id, resulting_revision
        )
        references sync_control_events(
            tenant_id, session_id, actor_participant_session_id,
            actor_generation, command_id, event_id, revision
        )
        on delete restrict;

alter table sync_control_events
    drop constraint sync_control_events_sync_v3_origin_check,
    drop constraint sync_control_events_sync_v3_external_event_key,
    drop constraint sync_control_events_sync_v3_receipt_event_key,
    drop column external_operation_id,
    add constraint sync_control_events_origin_check
        check (
            (
                command_id ~ '^[A-Za-z0-9_-]{16,64}$'
                and lifecycle_intent_id is null
                and actor_participant_session_id is not null
                and actor_generation > 0
            )
            or (
                command_id is null
                and lifecycle_intent_id is not null
                and actor_participant_session_id is null
                and actor_generation is null
            )
        );

alter table sync_session_control
    drop constraint sync_session_control_sync_v3_host_fkey,
    drop column host_participant_session_id;

alter table sync_control_events
    drop constraint sync_control_events_sync_v3_actor_generation_fkey;

alter table sync_lifecycle_intents
    drop constraint sync_lifecycle_intents_sync_v3_generation_fkey;

alter table sync_lifecycle_intents
    drop constraint sync_lifecycle_intents_sync_v3_target_check,
    add constraint sync_lifecycle_intents_target_check
        check (
            (
                intent_name in ('participant_joined', 'participant_left')
                and participant_session_id is not null
                and participant_session_generation > 0
            )
            or (
                intent_name = 'session_ended'
                and participant_session_id is null
                and participant_session_generation is null
            )
        );

drop index participants_sync_v3_one_host_per_session_idx;

alter table participants
    drop constraint participants_sync_v3_eligible_roles_check,
    drop constraint participants_sync_v3_role_check,
    drop constraint participants_sync_v3_generation_key,
    drop column eligible_roles,
    drop column role;

drop trigger room_sessions_sync_v3_immutable_policy on room_sessions;
drop function sync_v3_protect_immutable_session_policy();

alter table room_sessions
    drop constraint room_sessions_sync_v3_duration_check,
    drop constraint room_sessions_sync_v3_role_capabilities_check,
    drop constraint room_sessions_sync_v3_host_exit_policy_check,
    drop column deadline_generation,
    drop column deadline_at,
    drop column maximum_duration_ceiling_seconds,
    drop column maximum_duration_seconds,
    drop column role_capabilities,
    drop column host_exit_policy;

drop function sync_v3_valid_eligible_roles(text[]);
drop function sync_v3_valid_role_capabilities(jsonb);
