-- +goose Up
-- Existing-data policy: v2 control state and RFC 8785 digests cannot be
-- reconstructed from legacy room_sessions or participants rows. This migration
-- therefore only runs on an empty legacy lifecycle dataset. Operators must
-- retire or explicitly migrate existing lifecycle data before applying it.
-- +goose StatementBegin
do $$
begin
    if exists (select 1 from room_sessions) or exists (select 1 from participants) then
        raise exception 'sync production schema requires empty room_sessions and participants; retire or explicitly migrate legacy lifecycle data first';
    end if;
end;
$$;
-- +goose StatementEnd

alter table room_sessions
    add constraint room_sessions_sync_lifecycle_check
        check (status in ('active', 'ending', 'ended')),
    add constraint room_sessions_tenant_room_id_key
        unique (tenant_id, room_id, id);

create index room_sessions_sync_ended_cleanup_idx
    on room_sessions(ended_at, tenant_id, id)
    where status = 'ended';

alter table participants
    add column generation bigint not null,
    add column status text not null,
    add column joined_at timestamptz,
    add column left_at timestamptz,
    add constraint participants_generation_positive_check
        check (generation > 0),
    add constraint participants_sync_lifecycle_check
        check (status in ('joining', 'active', 'leaving', 'left')),
    add constraint participants_tenant_room_session_id_key
        unique (tenant_id, room_id, session_id, id),
    add constraint participants_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete restrict;

create table sync_session_control (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    control_revision bigint not null default 0,
    folded_state jsonb not null,
    state_schema_version integer not null,
    state_digest bytea not null,
    snapshot_bytes bigint not null,
    snapshot_reserved_bytes bigint not null default 0,
    participant_event_count bigint not null default 0,
    participant_event_bytes bigint not null default 0,
    lifecycle_event_count bigint not null default 0,
    lifecycle_event_bytes bigint not null default 0,
    lifecycle_reserved_events bigint not null default 1,
    lifecycle_reserved_bytes bigint not null default 16384,
    lifecycle_intent_count bigint not null default 0,
    lifecycle_intent_bytes bigint not null default 0,
    lifecycle_reserved_intents bigint not null default 1,
    lifecycle_reserved_intent_bytes bigint not null default 16384,
    receipt_count bigint not null default 0,
    receipt_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id),
    unique (tenant_id, room_id, session_id),
    constraint sync_session_control_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete restrict,
    constraint sync_session_control_state_schema_version_check
        check (state_schema_version > 0),
    constraint sync_session_control_state_digest_check
        check (octet_length(state_digest) = 32),
    constraint sync_session_control_capacity_check
        check (
            control_revision >= 0
            and snapshot_bytes >= 0
            and snapshot_reserved_bytes >= 0
            and participant_event_count between 0 and 250000
            and participant_event_bytes between 0 and 2147483648
            and lifecycle_event_count >= 0
            and lifecycle_event_bytes >= 0
            and lifecycle_reserved_events >= 0
            and lifecycle_reserved_bytes >= 0
            and lifecycle_intent_count >= 0
            and lifecycle_intent_bytes >= 0
            and lifecycle_reserved_intents >= 0
            and lifecycle_reserved_intent_bytes >= 0
            and receipt_count between 0 and 500000
            and receipt_bytes between 0 and 4294967296
            and snapshot_bytes + snapshot_reserved_bytes <= 1048576
            and lifecycle_event_count + lifecycle_reserved_events <= 2048
            and lifecycle_event_bytes + lifecycle_reserved_bytes <= 33554432
            and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
            and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes <= 33554432
        )
);

create table sync_lifecycle_intents (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    lifecycle_intent_id uuid primary key,
    request_key text not null,
    request_fingerprint bytea not null,
    intent_name text not null,
    participant_session_id uuid,
    participant_session_generation bigint,
    payload jsonb not null,
    status text not null,
    terminal_reason text,
    applied_event_id uuid,
    applied_revision bigint,
    attempt_count integer not null default 0,
    last_error_code text,
    created_at timestamptz not null default now(),
    completed_at timestamptz,
    unique (tenant_id, room_id, session_id, lifecycle_intent_id),
    unique (tenant_id, session_id, intent_name, request_key),
    constraint sync_lifecycle_intents_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    constraint sync_lifecycle_intents_participant_context_fkey
        foreign key (tenant_id, room_id, session_id, participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict,
    constraint sync_lifecycle_intents_request_key_check
        check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint sync_lifecycle_intents_request_fingerprint_check
        check (octet_length(request_fingerprint) = 32),
    constraint sync_lifecycle_intents_payload_bytes_check
        check (octet_length(payload::text) <= 16384),
    constraint sync_lifecycle_intents_target_check
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
        ),
    constraint sync_lifecycle_intents_attempt_count_check
        check (attempt_count >= 0),
    constraint sync_lifecycle_intents_status_check
        check (
            (
                status = 'pending'
                and terminal_reason is null
                and applied_event_id is null
                and applied_revision is null
                and completed_at is null
            )
            or (
                status = 'applied'
                and terminal_reason is null
                and applied_event_id is not null
                and applied_revision > 0
                and completed_at is not null
            )
            or (
                status = 'superseded'
                and terminal_reason in (
                    'superseded_by_session_end',
                    'participant_already_terminal',
                    'participant_generation_replaced'
                )
                and applied_event_id is null
                and applied_revision is null
                and completed_at is not null
            )
        )
);

create unique index sync_lifecycle_intents_session_end_key
    on sync_lifecycle_intents(tenant_id, session_id)
    where intent_name = 'session_ended';

create unique index sync_lifecycle_intents_participant_transition_key
    on sync_lifecycle_intents(
        tenant_id,
        session_id,
        intent_name,
        participant_session_id,
        participant_session_generation
    )
    where intent_name in ('participant_joined', 'participant_left');

create index sync_lifecycle_intents_pending_idx
    on sync_lifecycle_intents(created_at, lifecycle_intent_id)
    where status = 'pending';

create table sync_control_events (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    event_id uuid not null unique,
    base_revision bigint not null,
    revision bigint not null,
    event_name text not null,
    payload jsonb not null,
    actor_participant_session_id uuid,
    actor_generation bigint,
    command_id text,
    lifecycle_intent_id uuid,
    event_schema_version integer not null,
    resulting_state_digest bytea not null,
    encoded_bytes integer not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, revision),
    unique (
        tenant_id,
        session_id,
        lifecycle_intent_id,
        event_id,
        revision
    ),
    unique (
        tenant_id,
        session_id,
        actor_participant_session_id,
        actor_generation,
        command_id,
        event_id,
        revision
    ),
    constraint sync_control_events_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references sync_session_control(tenant_id, room_id, session_id)
        on delete restrict,
    constraint sync_control_events_participant_context_fkey
        foreign key (tenant_id, room_id, session_id, actor_participant_session_id)
        references participants(tenant_id, room_id, session_id, id)
        on delete restrict,
    constraint sync_control_events_revision_check
        check (base_revision >= 0 and revision = base_revision + 1),
    constraint sync_control_events_origin_check
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
        ),
    constraint sync_control_events_schema_version_check
        check (event_schema_version > 0),
    constraint sync_control_events_state_digest_check
        check (octet_length(resulting_state_digest) = 32),
    constraint sync_control_events_encoded_bytes_check
        check (encoded_bytes between 1 and 32768)
);

create unique index sync_control_events_command_origin_key
    on sync_control_events(
        tenant_id,
        session_id,
        actor_participant_session_id,
        command_id
    )
    where command_id is not null;

create unique index sync_control_events_lifecycle_origin_key
    on sync_control_events(tenant_id, session_id, lifecycle_intent_id)
    where lifecycle_intent_id is not null;

create table sync_command_receipts (
    tenant_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    submitted_generation bigint not null,
    command_id text not null,
    request_fingerprint bytea not null,
    command_name text not null,
    outcome text not null,
    rejection_reason text,
    event_id uuid,
    resulting_revision bigint,
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, participant_session_id, command_id),
    constraint sync_command_receipts_session_fkey
        foreign key (tenant_id, session_id)
        references sync_session_control(tenant_id, session_id)
        on delete restrict,
    constraint sync_command_receipts_committed_event_fkey
        foreign key (
            tenant_id,
            session_id,
            participant_session_id,
            submitted_generation,
            command_id,
            event_id,
            resulting_revision
        )
        references sync_control_events(
            tenant_id,
            session_id,
            actor_participant_session_id,
            actor_generation,
            command_id,
            event_id,
            revision
        )
        on delete restrict,
    constraint sync_command_receipts_submitted_generation_check
        check (submitted_generation > 0),
    constraint sync_command_receipts_command_id_check
        check (command_id ~ '^[A-Za-z0-9_-]{16,64}$'),
    constraint sync_command_receipts_request_fingerprint_check
        check (octet_length(request_fingerprint) = 32),
    constraint sync_command_receipts_command_name_check
        check (command_name in ('raise_hand', 'lower_hand')),
    constraint sync_command_receipts_outcome_check
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
);

alter table sync_lifecycle_intents
    add constraint sync_lifecycle_intents_applied_event_fkey
        foreign key (
            tenant_id,
            session_id,
            lifecycle_intent_id,
            applied_event_id,
            applied_revision
        )
        references sync_control_events(
            tenant_id,
            session_id,
            lifecycle_intent_id,
            event_id,
            revision
        )
        on delete restrict;

-- +goose Down
drop table sync_command_receipts;

alter table sync_lifecycle_intents
    drop constraint sync_lifecycle_intents_applied_event_fkey;

drop table sync_control_events;
drop table sync_lifecycle_intents;
drop table sync_session_control;

drop index room_sessions_sync_ended_cleanup_idx;

alter table participants
    drop constraint participants_session_context_fkey,
    drop constraint participants_tenant_room_session_id_key,
    drop constraint participants_sync_lifecycle_check,
    drop constraint participants_generation_positive_check,
    drop column left_at,
    drop column joined_at,
    drop column status,
    drop column generation;

alter table room_sessions
    drop constraint room_sessions_tenant_room_id_key,
    drop constraint room_sessions_sync_lifecycle_check;
