-- name: GetTenantRecording :one
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: ListTenantRecordings :many
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        sqlc.narg(episode_id)::uuid is null
        or episode_id = sqlc.narg(episode_id)::uuid
    )
    and (
        sqlc.narg(space_id)::uuid is null
        or space_id = sqlc.narg(space_id)::uuid
    )
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: ListTenantSpaceRecordings :many
select
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    storage_content_type,
    storage_size,
    storage_checksum,
    duration_millis,
    completed_at,
    metadata,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and (
        sqlc.narg(episode_id)::uuid is null
        or episode_id = sqlc.narg(episode_id)::uuid
    )
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;
