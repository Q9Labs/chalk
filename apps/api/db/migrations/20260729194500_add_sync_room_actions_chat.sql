-- +goose Up
alter table room_sessions
    add column room_action_role_capabilities jsonb not null
        default '{"host":["sendReaction","sendChat"],"cohost":["sendReaction","sendChat"],"participant":["sendReaction","sendChat"]}'::jsonb,
    add constraint room_sessions_room_action_role_capabilities_check
        check (
            jsonb_typeof(room_action_role_capabilities) = 'object'
            and room_action_role_capabilities ?& array['host', 'cohost', 'participant']
            and room_action_role_capabilities - array['host', 'cohost', 'participant'] = '{}'::jsonb
            and jsonb_typeof(room_action_role_capabilities -> 'host') = 'array'
            and jsonb_typeof(room_action_role_capabilities -> 'cohost') = 'array'
            and jsonb_typeof(room_action_role_capabilities -> 'participant') = 'array'
            and not jsonb_path_exists(
                room_action_role_capabilities,
                '$.*[*] ? (@ != "sendReaction" && @ != "sendChat")'
            )
        );

create table sync_chat_streams (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    head_sequence bigint not null default 0,
    retained_floor_sequence bigint,
    message_count bigint not null default 0,
    message_bytes bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    primary key (tenant_id, session_id),
    unique (tenant_id, room_id, session_id),
    constraint sync_chat_streams_session_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references room_sessions(tenant_id, room_id, id)
        on delete restrict,
    constraint sync_chat_streams_capacity_check
        check (
            head_sequence >= 0
            and message_count between 0 and 250000
            and message_bytes between 0 and 2147483648
            and (
                (
                    head_sequence = 0
                    and retained_floor_sequence is null
                    and message_count = 0
                    and message_bytes = 0
                )
                or (
                    head_sequence > 0
                    and retained_floor_sequence between 1 and head_sequence + 1
                    and message_count = head_sequence - retained_floor_sequence + 1
                )
            )
        )
);

create table sync_chat_messages (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    sequence bigint not null,
    message_id uuid not null,
    participant_session_id uuid not null,
    participant_session_generation bigint not null,
    client_message_id text not null,
    request_fingerprint bytea not null,
    display_name text not null,
    message_text text not null,
    encoded_bytes bigint not null,
    created_at timestamptz not null,
    primary key (tenant_id, session_id, sequence),
    unique (tenant_id, session_id, message_id),
    unique (
        tenant_id,
        session_id,
        participant_session_id,
        participant_session_generation,
        client_message_id
    ),
    constraint sync_chat_messages_stream_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references sync_chat_streams(tenant_id, room_id, session_id)
        on delete restrict,
    constraint sync_chat_messages_participant_generation_fkey
        foreign key (
            tenant_id,
            room_id,
            session_id,
            participant_session_id,
            participant_session_generation
        )
        references participants(
            tenant_id,
            room_id,
            session_id,
            id,
            generation
        )
        on delete restrict,
    constraint sync_chat_messages_sequence_check
        check (sequence > 0),
    constraint sync_chat_messages_client_message_id_check
        check (octet_length(client_message_id) between 16 and 64),
    constraint sync_chat_messages_request_fingerprint_check
        check (octet_length(request_fingerprint) = 32),
    constraint sync_chat_messages_display_name_check
        check (octet_length(display_name) between 1 and 256),
    constraint sync_chat_messages_text_check
        check (
            octet_length(message_text) between 1 and 16384
            and char_length(message_text) <= 4000
        ),
    constraint sync_chat_messages_encoded_bytes_check
        check (encoded_bytes between 1 and 32768)
);

create index sync_chat_messages_session_created_at_idx
    on sync_chat_messages(tenant_id, session_id, created_at, sequence);

-- +goose Down
drop table if exists sync_chat_messages;
drop table if exists sync_chat_streams;
alter table room_sessions
    drop constraint room_sessions_room_action_role_capabilities_check,
    drop column room_action_role_capabilities;
