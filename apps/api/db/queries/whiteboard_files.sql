-- name: GetReadyWhiteboardFile :one
select
    file.upload_id,
    file.tenant_id,
    file.space_id,
    file.episode_id,
    file.scene_id,
    file.participant_id,
    file.participant_generation,
    file.file_id,
    file.object_key,
    file.mime_type,
    file.byte_length,
    file.sha256,
    file.expires_at
from sync_whiteboard_files file
join participants participant
    on participant.tenant_id = file.tenant_id
    and participant.space_id = file.space_id
    and participant.episode_id = file.episode_id
    and participant.id = sqlc.arg(participant_id)
    and participant.generation = sqlc.arg(participant_generation)
join episodes episode
    on episode.tenant_id = file.tenant_id
    and episode.space_id = file.space_id
    and episode.id = file.episode_id
join sync_whiteboard_scenes scene
    on scene.tenant_id = file.tenant_id
    and scene.space_id = file.space_id
    and scene.episode_id = file.episode_id
    and scene.scene_id = file.scene_id
where file.tenant_id = sqlc.arg(tenant_id)
    and file.space_id = sqlc.arg(space_id)
    and file.episode_id = sqlc.arg(episode_id)
    and file.file_id = sqlc.arg(file_id)
    and file.status = 'ready'
    and file.cleanup_claim_token is null
    and participant.status = 'active'
    and episode.status = 'active'
    and scene.is_current;

-- name: ClaimWhiteboardFileCleanup :many
with candidates as (
    select file.upload_id
    from sync_whiteboard_files file
    join episodes episode
        on episode.tenant_id = file.tenant_id
        and episode.space_id = file.space_id
        and episode.id = file.episode_id
    where (
        file.cleanup_claimed_until is null
        or file.cleanup_claimed_until <= sqlc.arg(now_at)
    )
        and (
            (
                file.status in ('pending', 'finalizing', 'failed')
                and file.expires_at <= sqlc.arg(now_at) - interval '15 minutes'
            )
            or (
                file.status = 'ready' and file.referenced_at is null
                and file.expires_at <= sqlc.arg(now_at)
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
            else file.expires_at
        end,
        file.upload_id
    for update of file skip locked
    limit sqlc.arg(batch_limit)
)
update sync_whiteboard_files file
set
    cleanup_claim_token = sqlc.arg(claim_token),
    cleanup_claimed_until = sqlc.arg(lease_until),
    cleanup_attempts = cleanup_attempts + 1,
    updated_at = now()
from candidates
where file.upload_id = candidates.upload_id
returning file.upload_id, file.object_key;

-- name: CompleteWhiteboardFileCleanup :execrows
delete from sync_whiteboard_files
where upload_id = sqlc.arg(upload_id)
    and cleanup_claim_token = sqlc.arg(claim_token);

-- name: CanWriteWhiteboardFile :one
select exists (
    select 1 from sync_whiteboard_file_writers
    where (tenant_id, space_id, episode_id, participant_id, participant_generation, scene_id) =
        (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(participant_id), sqlc.arg(participant_generation)::bigint, sqlc.arg(scene_id))
);

-- name: ReserveWhiteboardFile :one
insert into sync_whiteboard_files as file (
    upload_id, tenant_id, space_id, episode_id, participant_id, participant_generation,
    scene_id, file_id, object_key, mime_type, byte_length, sha256, expires_at
)
select sqlc.arg(upload_id), writer.tenant_id, writer.space_id, writer.episode_id,
    writer.participant_id, writer.participant_generation, writer.scene_id, sqlc.arg(file_id),
    sqlc.arg(object_key), sqlc.arg(mime_type), sqlc.arg(byte_length), sqlc.arg(sha256), sqlc.arg(expires_at)
from sync_whiteboard_file_writers writer
where (writer.tenant_id, writer.space_id, writer.episode_id, writer.participant_id, writer.participant_generation, writer.scene_id) =
    (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(participant_id), sqlc.arg(participant_generation)::bigint, sqlc.arg(scene_id))
on conflict (tenant_id, space_id, scene_id, file_id) do update
set updated_at = now()
where file.episode_id = excluded.episode_id
    and file.cleanup_claim_token is null
    and file.sha256 = excluded.sha256
    and file.mime_type = excluded.mime_type
    and file.byte_length = excluded.byte_length
    and (
        file.status = 'ready'
        or (file.status = 'pending' and file.expires_at > now()
            and file.participant_id = excluded.participant_id
            and file.participant_generation = excluded.participant_generation)
    )
returning file.upload_id, file.object_key, file.status, file.expires_at;

-- name: GetWhiteboardFileUpload :one
select file.upload_id, file.object_key, file.mime_type, file.byte_length, file.sha256,
    file.status, file.expires_at
from sync_whiteboard_files file
join sync_whiteboard_file_writers writer
    using (tenant_id, space_id, episode_id, scene_id)
where (writer.tenant_id, writer.space_id, writer.episode_id, writer.participant_id, writer.participant_generation, writer.scene_id) =
    (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(participant_id), sqlc.arg(participant_generation)::bigint, sqlc.arg(scene_id))
    and file.file_id = sqlc.arg(file_id)
    and file.cleanup_claim_token is null
    and (
        file.status = 'ready'
        or (file.status = 'pending' and file.expires_at > now()
            and file.participant_id = writer.participant_id
            and file.participant_generation = writer.participant_generation)
    );

-- name: FinalizeWhiteboardFile :execrows
update sync_whiteboard_files file
set status = 'ready',
    immutable_object_identity = sqlc.arg(immutable_object_identity),
    finalized_at = now(),
    expires_at = sqlc.arg(expires_at),
    updated_at = now()
from sync_whiteboard_file_writers writer
where (writer.tenant_id, writer.space_id, writer.episode_id, writer.participant_id, writer.participant_generation, writer.scene_id) =
    (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(participant_id), sqlc.arg(participant_generation)::bigint, sqlc.arg(scene_id))
    and (file.tenant_id, file.space_id, file.episode_id, file.participant_id, file.participant_generation, file.scene_id) =
        (writer.tenant_id, writer.space_id, writer.episode_id, writer.participant_id, writer.participant_generation, writer.scene_id)
    and file.upload_id = sqlc.arg(upload_id)
    and file.status = 'pending'
    and file.expires_at > now()
    and file.cleanup_claim_token is null;
