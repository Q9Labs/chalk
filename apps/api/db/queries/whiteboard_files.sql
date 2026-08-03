-- name: ReserveWhiteboardFileUpload :execrows
insert into sync_whiteboard_files (
    upload_id,
    tenant_id,
    space_id,
    episode_id,
    scene_id,
    participant_id,
    participant_generation,
    file_id,
    object_key,
    mime_type,
    byte_length,
    sha256,
    expires_at
)
select
    sqlc.arg(upload_id),
    participant.tenant_id,
    participant.space_id,
    participant.episode_id,
    scene.scene_id,
    participant.id,
    participant.generation,
    sqlc.arg(file_id),
    sqlc.arg(object_key),
    sqlc.arg(mime_type),
    sqlc.arg(byte_length),
    sqlc.arg(sha256),
    sqlc.arg(expires_at)
from participants participant
join episodes episode
    on episode.tenant_id = participant.tenant_id
    and episode.space_id = participant.space_id
    and episode.id = participant.episode_id
join sync_whiteboard_scenes scene
    on scene.tenant_id = participant.tenant_id
    and scene.space_id = participant.space_id
    and scene.scene_id = sqlc.arg(scene_id)
    and scene.is_current
left join sync_whiteboard_permissions permission
    on permission.tenant_id = participant.tenant_id
    and permission.space_id = participant.space_id
    and permission.episode_id = participant.episode_id
    and permission.participant_id = participant.id
where participant.tenant_id = sqlc.arg(tenant_id)
    and participant.space_id = sqlc.arg(space_id)
    and participant.episode_id = sqlc.arg(episode_id)
    and participant.id = sqlc.arg(participant_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and episode.status = 'active'
    and coalesce(
        permission.can_draw,
        participant.capabilities @> array['drawWhiteboard']::text[]
    );

-- name: ClaimWhiteboardFileUploadFinalize :one
update sync_whiteboard_files file
set status = 'finalizing', updated_at = now()
from participants participant, sync_whiteboard_scenes scene
where file.upload_id = sqlc.arg(upload_id)
    and file.tenant_id = sqlc.arg(tenant_id)
    and file.space_id = sqlc.arg(space_id)
    and file.episode_id = sqlc.arg(episode_id)
    and file.participant_id = sqlc.arg(participant_id)
    and file.participant_generation = sqlc.arg(participant_generation)
    and file.status = 'pending'
    and file.expires_at > sqlc.arg(now_at)
    and participant.tenant_id = file.tenant_id
    and participant.space_id = file.space_id
    and participant.episode_id = file.episode_id
    and participant.id = file.participant_id
    and participant.generation = file.participant_generation
    and participant.status = 'active'
    and scene.tenant_id = file.tenant_id
    and scene.space_id = file.space_id
    and scene.scene_id = file.scene_id
    and scene.is_current
returning
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
    file.expires_at;

-- name: FailWhiteboardFileUpload :execrows
update sync_whiteboard_files
set status = 'failed', updated_at = now()
where upload_id = sqlc.arg(upload_id)
    and status in ('pending', 'finalizing');

-- name: CompleteWhiteboardFileUpload :execrows
update sync_whiteboard_files
set
    status = 'ready',
    immutable_object_identity = sqlc.arg(immutable_object_identity),
    finalized_at = now(),
    updated_at = now()
where upload_id = sqlc.arg(upload_id)
    and status = 'finalizing';

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
    and scene.scene_id = file.scene_id
where file.tenant_id = sqlc.arg(tenant_id)
    and file.space_id = sqlc.arg(space_id)
    and file.episode_id = sqlc.arg(episode_id)
    and file.file_id = sqlc.arg(file_id)
    and file.status = 'ready'
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
