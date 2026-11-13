-- name: LockChatAttachmentStream :one
-- Reservations in one Space wait here, so the per-person count in the next statement sees every
-- reservation committed before it. It returns no row when the Participant may not send chat.
insert into sync_chat_streams (tenant_id, space_id)
select participant.tenant_id, participant.space_id
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
on conflict (tenant_id, space_id) do update set updated_at = sync_chat_streams.updated_at
returning tenant_id;

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
        -- One person may hold at most 40 attachments or 200 MiB of the Space budget, however many
        -- times they rejoin. chat_person_participant_ids is shared with Sync's message limits.
        and (
            select count(*) < 40
                and coalesce(sum(held.byte_length), 0) + sqlc.arg(byte_length) <= 209715200
            from sync_chat_attachments held
            where held.tenant_id = sqlc.arg(tenant_id)
                and held.space_id = sqlc.arg(space_id)
                and held.participant_id = any(array(
                    select participant_id
                    from chat_person_participant_ids(sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(participant_id))
                ))
        )
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
    authority.episode_id,
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
