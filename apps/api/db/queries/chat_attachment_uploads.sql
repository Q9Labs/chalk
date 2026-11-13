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
