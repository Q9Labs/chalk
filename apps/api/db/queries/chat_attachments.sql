-- name: ReserveChatAttachmentUpload :one
with authority as materialized (
    select
        participant.tenant_id,
        participant.space_id,
        participant.episode_id,
        participant.id,
        participant.generation
    from participants participant
    join episodes episode
        on episode.tenant_id = participant.tenant_id
        and episode.space_id = participant.space_id
        and episode.id = participant.episode_id
    where participant.tenant_id = sqlc.arg(tenant_id)
        and participant.space_id = sqlc.arg(space_id)
        and participant.episode_id = sqlc.arg(episode_id)
        and participant.id = sqlc.arg(participant_id)
        and participant.generation = sqlc.arg(participant_generation)
        and participant.status = 'active'
        and episode.status = 'active'
        and participant.capabilities @> array['sendChat']::text[]
),
reservation as (
    insert into sync_chat_streams (
        tenant_id,
        space_id,
        attachment_count,
        attachment_bytes
    )
    select
        tenant_id,
        space_id,
        1,
        sqlc.arg(byte_length)
    from authority
    on conflict (tenant_id, space_id) do update set
        attachment_count = sync_chat_streams.attachment_count + 1,
        attachment_bytes = sync_chat_streams.attachment_bytes + sqlc.arg(byte_length),
        updated_at = now()
    where sync_chat_streams.space_id = excluded.space_id
        and sync_chat_streams.attachment_count < 1000
        and sync_chat_streams.attachment_bytes + sqlc.arg(byte_length) <= 5368709120
    returning
        sync_chat_streams.tenant_id,
        sync_chat_streams.space_id
)
insert into sync_chat_attachments (
    tenant_id,
    space_id,
    episode_id,
    attachment_id,
    participant_id,
    participant_generation,
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
    reservation.space_id,
    reservation.episode_id,
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
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and participant_id = sqlc.arg(participant_id)
    and participant_generation = sqlc.arg(participant_generation)
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
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and participant_id = sqlc.arg(participant_id)
    and participant_generation = sqlc.arg(participant_generation);

-- name: ClaimChatAttachmentUploadFinalize :one
update sync_chat_attachments attachment
set
    status = 'finalizing',
    finalize_claim_token = sqlc.arg(finalize_claim_token),
    finalize_claimed_until = sqlc.arg(finalize_claimed_until),
    finalize_attempts = finalize_attempts + 1,
    updated_at = now()
from participants participant, episodes episode
where attachment.upload_id = sqlc.arg(upload_id)
    and attachment.tenant_id = sqlc.arg(tenant_id)
    and attachment.space_id = sqlc.arg(space_id)
    and attachment.episode_id = sqlc.arg(episode_id)
    and attachment.participant_id = sqlc.arg(participant_id)
    and attachment.participant_generation = sqlc.arg(participant_generation)
    and (
        attachment.status = 'pending'
        or (
            attachment.status = 'finalizing'
            and attachment.finalize_claimed_until <= sqlc.arg(now_at)
        )
    )
    and attachment.expires_at > sqlc.arg(now_at)
    and participant.tenant_id = attachment.tenant_id
    and participant.space_id = attachment.space_id
    and participant.episode_id = attachment.episode_id
    and participant.id = attachment.participant_id
    and participant.generation = attachment.participant_generation
    and participant.status = 'active'
    and episode.tenant_id = attachment.tenant_id
    and episode.space_id = attachment.space_id
    and episode.id = attachment.episode_id
    and episode.status = 'active'
    and participant.capabilities @> array['sendChat']::text[]
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

-- name: ReleaseChatAttachmentUploadFinalize :execrows
update sync_chat_attachments
set
    status = 'pending',
    finalize_claim_token = null,
    finalize_claimed_until = null,
    updated_at = now()
where upload_id = sqlc.arg(upload_id)
    and status = 'finalizing'
    and finalize_claim_token = sqlc.arg(finalize_claim_token);

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
    and participant.space_id = attachment.space_id
    and participant.episode_id = attachment.episode_id
join episodes episode
    on episode.tenant_id = attachment.tenant_id
    and episode.space_id = attachment.space_id
    and episode.id = attachment.episode_id
where attachment.tenant_id = sqlc.arg(tenant_id)
    and attachment.space_id = sqlc.arg(space_id)
    and attachment.episode_id = sqlc.arg(episode_id)
    and attachment.attachment_id = sqlc.arg(attachment_id)
    and participant.id = sqlc.arg(participant_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and episode.status = 'active'
    and (
        attachment.status = 'attached'
        or (
            attachment.status = 'ready'
            and attachment.participant_id = participant.id
            and attachment.participant_generation = participant.generation
        )
    );

-- name: ClaimChatAttachmentCleanup :many
with candidates as (
    select attachment.tenant_id, attachment.space_id, attachment.episode_id, attachment.attachment_id
    from sync_chat_attachments attachment
    join episodes episode
        on episode.tenant_id = attachment.tenant_id
        and episode.space_id = attachment.space_id
        and episode.id = attachment.episode_id
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
                episode.status = 'ended'
                and episode.ended_at <= sqlc.arg(ended_before)
            )
        )
    order by
        case
            when episode.status = 'ended' and episode.ended_at <= sqlc.arg(ended_before)
                then episode.ended_at
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
    and attachment.space_id = candidates.space_id
    and attachment.episode_id = candidates.episode_id
    and attachment.attachment_id = candidates.attachment_id
returning
    attachment.tenant_id,
    attachment.space_id,
    attachment.episode_id,
    attachment.attachment_id,
    attachment.object_key,
    attachment.byte_length;

-- name: CompleteChatAttachmentCleanup :one
with removed as (
    delete from sync_chat_attachments attachment
    where attachment.tenant_id = sqlc.arg(tenant_id)
        and attachment.episode_id = sqlc.arg(episode_id)
        and attachment.attachment_id = sqlc.arg(attachment_id)
        and attachment.cleanup_claim_token = sqlc.arg(claim_token)
    returning attachment.tenant_id, attachment.space_id, attachment.episode_id, attachment.byte_length
),
released as (
    update sync_chat_streams stream
    set
        attachment_count = attachment_count - 1,
        attachment_bytes = attachment_bytes - removed.byte_length,
        updated_at = now()
    from removed
    where stream.tenant_id = removed.tenant_id
        and stream.space_id = removed.space_id
    returning 1
)
select count(*) from released;
