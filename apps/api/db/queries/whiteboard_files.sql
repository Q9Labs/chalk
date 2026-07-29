-- name: ReserveWhiteboardFileUpload :execrows
insert into sync_whiteboard_files (
    upload_id,
    tenant_id,
    room_id,
    session_id,
    scene_id,
    participant_session_id,
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
    participant.room_id,
    participant.session_id,
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
join room_sessions session
    on session.tenant_id = participant.tenant_id
    and session.room_id = participant.room_id
    and session.id = participant.session_id
join sync_whiteboard_scenes scene
    on scene.tenant_id = participant.tenant_id
    and scene.room_id = participant.room_id
    and scene.session_id = participant.session_id
    and scene.scene_id = sqlc.arg(scene_id)
    and scene.is_current
left join sync_whiteboard_permissions permission
    on permission.tenant_id = participant.tenant_id
    and permission.session_id = participant.session_id
    and permission.participant_session_id = participant.id
where participant.tenant_id = sqlc.arg(tenant_id)
    and participant.room_id = sqlc.arg(room_id)
    and participant.session_id = sqlc.arg(session_id)
    and participant.id = sqlc.arg(participant_session_id)
    and participant.generation = sqlc.arg(participant_generation)
    and participant.status = 'active'
    and session.status = 'active'
    and coalesce(
        permission.can_draw,
        (session.whiteboard_role_capabilities -> participant.role) ? 'drawWhiteboard'
    );

-- name: ClaimWhiteboardFileUploadFinalize :one
update sync_whiteboard_files file
set status = 'finalizing', updated_at = now()
from participants participant, sync_whiteboard_scenes scene
where file.upload_id = sqlc.arg(upload_id)
    and file.tenant_id = sqlc.arg(tenant_id)
    and file.room_id = sqlc.arg(room_id)
    and file.session_id = sqlc.arg(session_id)
    and file.participant_session_id = sqlc.arg(participant_session_id)
    and file.participant_generation = sqlc.arg(participant_generation)
    and file.status = 'pending'
    and file.expires_at > sqlc.arg(now_at)
    and participant.tenant_id = file.tenant_id
    and participant.room_id = file.room_id
    and participant.session_id = file.session_id
    and participant.id = file.participant_session_id
    and participant.generation = file.participant_generation
    and participant.status = 'active'
    and scene.tenant_id = file.tenant_id
    and scene.room_id = file.room_id
    and scene.session_id = file.session_id
    and scene.scene_id = file.scene_id
    and scene.is_current
returning
    file.upload_id,
    file.tenant_id,
    file.room_id,
    file.session_id,
    file.scene_id,
    file.participant_session_id,
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
    file.room_id,
    file.session_id,
    file.scene_id,
    file.participant_session_id,
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
    and participant.room_id = file.room_id
    and participant.session_id = file.session_id
    and participant.id = sqlc.arg(participant_session_id)
    and participant.generation = sqlc.arg(participant_generation)
join room_sessions session
    on session.tenant_id = file.tenant_id
    and session.room_id = file.room_id
    and session.id = file.session_id
join sync_whiteboard_scenes scene
    on scene.tenant_id = file.tenant_id
    and scene.room_id = file.room_id
    and scene.session_id = file.session_id
    and scene.scene_id = file.scene_id
where file.tenant_id = sqlc.arg(tenant_id)
    and file.room_id = sqlc.arg(room_id)
    and file.session_id = sqlc.arg(session_id)
    and file.file_id = sqlc.arg(file_id)
    and file.status = 'ready'
    and participant.status = 'active'
    and session.status = 'active'
    and scene.is_current;

-- name: ClaimWhiteboardFileCleanup :many
with candidates as (
    select file.upload_id
    from sync_whiteboard_files file
    join room_sessions session
        on session.tenant_id = file.tenant_id
        and session.room_id = file.room_id
        and session.id = file.session_id
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
                session.status = 'ended'
                and session.ended_at <= sqlc.arg(ended_before)
            )
        )
    order by
        case
            when session.status = 'ended' and session.ended_at <= sqlc.arg(ended_before)
                then session.ended_at
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
