-- +goose Up
alter table sync_chat_streams
    add column attachment_count bigint not null default 0,
    add column attachment_bytes bigint not null default 0;

alter table sync_chat_streams
    drop constraint sync_chat_streams_capacity_check,
    add constraint sync_chat_streams_capacity_check
        check (
            head_sequence >= 0
            and message_count between 0 and 250000
            and message_bytes between 0 and 2147483648
            and attachment_count between 0 and 1000
            and attachment_bytes between 0 and 5368709120
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
        );

alter table sync_chat_messages
    drop constraint sync_chat_messages_text_check,
    add constraint sync_chat_messages_text_check
        check (
            octet_length(message_text) between 0 and 16384
            and char_length(message_text) <= 4000
        );

create table sync_chat_attachments (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    attachment_id uuid not null,
    participant_session_id uuid not null,
    participant_session_generation bigint not null,
    client_attachment_id text not null,
    request_fingerprint bytea not null,
    upload_id uuid not null,
    object_key text not null,
    original_filename text not null,
    mime_type text not null,
    byte_length bigint not null,
    sha256 bytea not null,
    immutable_object_identity text,
    status text not null,
    expires_at timestamptz not null,
    message_sequence bigint,
    message_ordinal smallint,
    finalize_claim_token uuid,
    finalize_claimed_until timestamptz,
    finalize_attempts integer not null default 0,
    cleanup_claim_token uuid,
    cleanup_claimed_until timestamptz,
    cleanup_attempts integer not null default 0,
    finalized_at timestamptz,
    attached_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (tenant_id, session_id, attachment_id),
    unique (upload_id),
    unique (object_key),
    unique (
        tenant_id,
        session_id,
        participant_session_id,
        participant_session_generation,
        client_attachment_id
    ),
    unique (tenant_id, session_id, message_sequence, message_ordinal),
    constraint sync_chat_attachments_stream_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references sync_chat_streams(tenant_id, room_id, session_id)
        on delete restrict,
    constraint sync_chat_attachments_participant_generation_fkey
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
    constraint sync_chat_attachments_message_fkey
        foreign key (tenant_id, session_id, message_sequence)
        references sync_chat_messages(tenant_id, session_id, sequence)
        on delete restrict,
    constraint sync_chat_attachments_client_id_check
        check (octet_length(client_attachment_id) between 16 and 64),
    constraint sync_chat_attachments_fingerprint_check
        check (octet_length(request_fingerprint) = 32),
    constraint sync_chat_attachments_object_key_check
        check (octet_length(object_key) between 1 and 1024),
    constraint sync_chat_attachments_filename_check
        check (octet_length(original_filename) between 1 and 255),
    constraint sync_chat_attachments_mime_type_check
        check (
            mime_type in (
                'image/png',
                'image/jpeg',
                'image/gif',
                'image/webp',
                'application/pdf',
                'text/plain',
                'application/msword',
                'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'application/vnd.ms-excel',
                'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'application/vnd.ms-powerpoint',
                'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'application/vnd.oasis.opendocument.text',
                'application/vnd.oasis.opendocument.spreadsheet',
                'application/vnd.oasis.opendocument.presentation'
            )
        ),
    constraint sync_chat_attachments_byte_length_check
        check (byte_length between 1 and 26214400),
    constraint sync_chat_attachments_sha256_check
        check (octet_length(sha256) = 32),
    constraint sync_chat_attachments_identity_check
        check (
            immutable_object_identity is null
            or octet_length(immutable_object_identity) between 1 and 512
        ),
    constraint sync_chat_attachments_status_check
        check (status in ('pending', 'finalizing', 'ready', 'attached', 'failed')),
    constraint sync_chat_attachments_binding_check
        check (
            (
                status = 'attached'
                and message_sequence is not null
                and message_ordinal between 0 and 4
                and attached_at is not null
            )
            or (
                status <> 'attached'
                and message_sequence is null
                and message_ordinal is null
                and attached_at is null
            )
        ),
    constraint sync_chat_attachments_finalization_check
        check (
            (
                status in ('ready', 'attached')
                and immutable_object_identity is not null
                and finalized_at is not null
            )
            or status in ('pending', 'finalizing', 'failed')
        ),
    constraint sync_chat_attachments_finalize_claim_check
        check (
            finalize_attempts >= 0
            and (
                (
                    status = 'finalizing'
                    and finalize_claim_token is not null
                    and finalize_claimed_until is not null
                )
                or (
                    status <> 'finalizing'
                    and finalize_claim_token is null
                    and finalize_claimed_until is null
                )
            )
        ),
    constraint sync_chat_attachments_cleanup_check
        check (
            cleanup_attempts >= 0
            and (
                (cleanup_claim_token is null and cleanup_claimed_until is null)
                or (cleanup_claim_token is not null and cleanup_claimed_until is not null)
            )
        )
);

create index sync_chat_attachments_cleanup_idx
    on sync_chat_attachments(status, expires_at)
    where status <> 'attached';

create index sync_chat_attachments_session_status_idx
    on sync_chat_attachments(tenant_id, session_id, status);

create index sync_chat_attachments_finalize_lease_idx
    on sync_chat_attachments(finalize_claimed_until)
    where status = 'finalizing';

create table sync_chat_read_receipts (
    tenant_id uuid not null,
    room_id uuid not null,
    session_id uuid not null,
    participant_session_id uuid not null,
    participant_session_generation bigint not null,
    sequence bigint not null,
    read_at timestamptz not null,
    updated_at timestamptz not null default now(),
    primary key (
        tenant_id,
        session_id,
        participant_session_id,
        participant_session_generation
    ),
    constraint sync_chat_read_receipts_stream_context_fkey
        foreign key (tenant_id, room_id, session_id)
        references sync_chat_streams(tenant_id, room_id, session_id)
        on delete restrict,
    constraint sync_chat_read_receipts_participant_generation_fkey
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
    constraint sync_chat_read_receipts_sequence_check
        check (sequence > 0)
);

-- +goose Down
drop table if exists sync_chat_read_receipts;
drop table if exists sync_chat_attachments;

alter table sync_chat_messages
    drop constraint sync_chat_messages_text_check,
    add constraint sync_chat_messages_text_check
        check (
            octet_length(message_text) between 1 and 16384
            and char_length(message_text) <= 4000
        );

alter table sync_chat_streams
    drop constraint sync_chat_streams_capacity_check,
    drop column attachment_bytes,
    drop column attachment_count,
    add constraint sync_chat_streams_capacity_check
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
        );
