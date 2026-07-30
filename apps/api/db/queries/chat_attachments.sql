-- name: ReserveChatAttachmentUpload :one
with authority as materialized (
    select
        participant.tenant_id,
        participant.room_id,
        participant.session_id,
        participant.id,
        participant.generation
    from participants participant
    join room_sessions session
        on session.tenant_id = participant.tenant_id
        and session.room_id = participant.room_id
        and session.id = participant.session_id
    where participant.tenant_id = sqlc.arg(tenant_id)
        and participant.room_id = sqlc.arg(room_id)
        and participant.session_id = sqlc.arg(session_id)
        and participant.id = sqlc.arg(participant_session_id)
        and participant.generation = sqlc.arg(participant_generation)
        and participant.status = 'active'
        and session.status = 'active'
        and (session.room_action_role_capabilities -> participant.role) ? 'sendChat'
),
reservation as (
    insert into sync_chat_streams (
        tenant_id,
        room_id,
        session_id,
        attachment_count,
        attachment_bytes
    )
    select
        tenant_id,
        room_id,
        session_id,
        1,
        sqlc.arg(byte_length)
    from authority
    on conflict (tenant_id, session_id) do update set
        attachment_count = sync_chat_streams.attachment_count + 1,
        attachment_bytes = sync_chat_streams.attachment_bytes + sqlc.arg(byte_length),
        updated_at = now()
    where sync_chat_streams.room_id = excluded.room_id
        and sync_chat_streams.attachment_count < 1000
        and sync_chat_streams.attachment_bytes + sqlc.arg(byte_length) <= 5368709120
    returning
        sync_chat_streams.tenant_id,
        sync_chat_streams.room_id,
        sync_chat_streams.session_id
)
insert into sync_chat_attachments (
    tenant_id,
    room_id,
    session_id,
    attachment_id,
    participant_session_id,
    participant_session_generation,
    client_attachment_id,
    request_fingerprint,
    upload_id,
    object_key,
    original_filename,
    mime_type,
    byte_length,
    sha256,
    status,
    expires_at
)
select
    reservation.tenant_id,
    reservation.room_id,
    reservation.session_id,
    sqlc.arg(attachment_id),
    authority.id,
    authority.generation,
    sqlc.arg(client_attachment_id),
    sqlc.arg(request_fingerprint),
    sqlc.arg(upload_id),
    sqlc.arg(object_key),
    sqlc.arg(original_filename),
    sqlc.arg(mime_type),
    sqlc.arg(byte_length),
    sqlc.arg(sha256),
    'pending',
    sqlc.arg(expires_at)
from reservation
join authority on true
returning
    attachment_id,
    upload_id,
    object_key,
    original_filename,
    mime_type,
    byte_length,
    sha256,
    request_fingerprint,
    status,
    expires_at;

-- name: GetChatAttachmentByClientID :one
select
    attachment_id,
    upload_id,
    object_key,
    original_filename,
    mime_type,
    byte_length,
    sha256,
    request_fingerprint,
    status,
    expires_at
from sync_chat_attachments
where tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and participant_session_id = sqlc.arg(participant_session_id)
    and participant_session_generation = sqlc.arg(participant_generation)
    and client_attachment_id = sqlc.arg(client_attachment_id);

-- name: GetChatAttachmentByUploadID :one
select
    attachment_id,
    upload_id,
    object_key,
    original_filename,
    mime_type,
    byte_length,
    sha256,
    request_fingerprint,
    status,
    expires_at
from sync_chat_attachments
where upload_id = sqlc.arg(upload_id)
    and tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and participant_session_id = sqlc.arg(participant_session_id)
    and participant_session_generation = sqlc.arg(participant_generation);

-- name: ClaimChatAttachmentUploadFinalize :one
update sync_chat_attachments attachment
set
    status = 'finalizing',
    finalize_claim_token = sqlc.arg(finalize_claim_token),
    finalize_claimed_until = sqlc.arg(finalize_claimed_until),
    finalize_attempts = finalize_attempts + 1,
    updated_at = now()
from participants participant, room_sessions session
where attachment.upload_id = sqlc.arg(upload_id)
    and attachment.tenant_id = sqlc.arg(tenant_id)
    and attachment.room_id = sqlc.arg(room_id)
    and attachment.session_id = sqlc.arg(session_id)
    and attachment.participant_session_id = sqlc.arg(participant_session_id)
    and attachment.participant_session_generation = sqlc.arg(participant_generation)
    and (
        attachment.status = 'pending'
        or (
            attachment.status = 'finalizing'
            and attachment.finalize_claimed_until <= sqlc.arg(now_at)
        )
    )
    and attachment.expires_at > sqlc.arg(now_at)
    and participant.tenant_id = attachment.tenant_id
    and participant.room_id = attachment.room_id
    and participant.session_id = attachment.session_id
    and participant.id = attachment.participant_session_id
    and participant.generation = attachment.participant_session_generation
    and participant.status = 'active'
    and session.tenant_id = attachment.tenant_id
    and session.room_id = attachment.room_id
    and session.id = attachment.session_id
    and session.status = 'active'
    and (session.room_action_role_capabilities -> participant.role) ? 'sendChat'
returning
    attachment.attachment_id,
    attachment.upload_id,
    attachment.object_key,
    attachment.original_filename,
    attachment.mime_type,
    attachment.byte_length,
    attachment.sha256,
    attachment.request_fingerprint,
    attachment.status,
    attachment.expires_at,
    attachment.finalize_claim_token,
    attachment.finalize_claimed_until;

-- name: FailChatAttachmentUpload :execrows
update sync_chat_attachments
set
    status = 'failed',
    finalize_claim_token = null,
    finalize_claimed_until = null,
    updated_at = now()
where upload_id = sqlc.arg(upload_id)
    and (
        status = 'pending'
        or (
            status = 'finalizing'
            and finalize_claim_token = sqlc.narg(finalize_claim_token)
        )
    );

-- name: CompleteChatAttachmentUpload :execrows
update sync_chat_attachments
set
    status = 'ready',
    immutable_object_identity = sqlc.arg(immutable_object_identity),
    finalized_at = now(),
    expires_at = sqlc.arg(expires_at),
    finalize_claim_token = null,
    finalize_claimed_until = null,
    updated_at = now()
where upload_id = sqlc.arg(upload_id)
    and status = 'finalizing'
    and finalize_claim_token = sqlc.arg(finalize_claim_token)
    and finalize_claimed_until > sqlc.arg(now_at);

-- name: GetAuthorizedChatAttachmentDownload :one
select
    attachment.attachment_id,
    attachment.upload_id,
    attachment.object_key,
    attachment.original_filename,
    attachment.mime_type,
    attachment.byte_length,
    attachment.sha256,
    attachment.request_fingerprint,
    attachment.status,
    attachment.expires_at
from sync_chat_attachments attachment
join participants participant
    on participant.tenant_id = attachment.tenant_id
    and participant.room_id = attachment.room_id
    and participant.session_id = attachment.session_id
join room_sessions session
    on session.tenant_id = attachment.tenant_id
    and session.room_id = attachment.room_id
    and session.id = attachment.session_id
where attachment.tenant_id = sqlc.arg(tenant_id)
    and attachment.room_id = sqlc.arg(room_id)
    and attachment.session_id = sqlc.arg(session_id)
    and attachment.attachment_id = sqlc.arg(attachment_id)
    and participant.id = sqlc.arg(participant_session_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and session.status = 'active'
    and (
        attachment.status = 'attached'
        or (
            attachment.status = 'ready'
            and attachment.participant_session_id = participant.id
            and attachment.participant_session_generation = participant.generation
        )
    );

-- name: ClaimChatAttachmentCleanup :many
with candidates as (
    select attachment.tenant_id, attachment.session_id, attachment.attachment_id
    from sync_chat_attachments attachment
    join room_sessions session
        on session.tenant_id = attachment.tenant_id
        and session.room_id = attachment.room_id
        and session.id = attachment.session_id
    where (
        attachment.cleanup_claimed_until is null
        or attachment.cleanup_claimed_until <= sqlc.arg(now_at)
    )
        and not (
            attachment.status = 'finalizing'
            and attachment.finalize_claimed_until > sqlc.arg(now_at)
        )
        and (
            (
                attachment.status <> 'attached'
                and attachment.expires_at <= sqlc.arg(now_at)
            )
            or (
                session.status = 'ended'
                and session.ended_at <= sqlc.arg(ended_before)
            )
        )
    order by
        case
            when session.status = 'ended' and session.ended_at <= sqlc.arg(ended_before)
                then session.ended_at
            else attachment.expires_at
        end,
        attachment.attachment_id
    for update of attachment skip locked
    limit sqlc.arg(batch_limit)
)
update sync_chat_attachments attachment
set
    cleanup_claim_token = sqlc.arg(claim_token),
    cleanup_claimed_until = sqlc.arg(lease_until),
    cleanup_attempts = cleanup_attempts + 1,
    updated_at = now()
from candidates
where attachment.tenant_id = candidates.tenant_id
    and attachment.session_id = candidates.session_id
    and attachment.attachment_id = candidates.attachment_id
returning
    attachment.tenant_id,
    attachment.session_id,
    attachment.attachment_id,
    attachment.object_key,
    attachment.byte_length;

-- name: CompleteChatAttachmentCleanup :one
with removed as (
    delete from sync_chat_attachments attachment
    where attachment.tenant_id = sqlc.arg(tenant_id)
        and attachment.session_id = sqlc.arg(session_id)
        and attachment.attachment_id = sqlc.arg(attachment_id)
        and attachment.cleanup_claim_token = sqlc.arg(claim_token)
    returning attachment.tenant_id, attachment.session_id, attachment.byte_length
),
released as (
    update sync_chat_streams stream
    set
        attachment_count = attachment_count - 1,
        attachment_bytes = attachment_bytes - removed.byte_length,
        updated_at = now()
    from removed
    where stream.tenant_id = removed.tenant_id
        and stream.session_id = removed.session_id
    returning 1
)
select count(*) from released;
