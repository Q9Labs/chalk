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
