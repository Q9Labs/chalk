-- name: CreateRecording :one
insert into recordings (
    id,
    tenant_id,
    room_id,
    session_id,
    status,
    storage_provider,
    storage_key,
    metadata
) select
    sqlc.arg(id),
    room_sessions.tenant_id,
    room_sessions.room_id,
    room_sessions.id,
    sqlc.arg(status),
    sqlc.arg(storage_provider),
    sqlc.narg(storage_key),
    sqlc.narg(metadata)
from room_sessions
where
    room_sessions.tenant_id = sqlc.arg(tenant_id)
    and room_sessions.room_id = sqlc.arg(room_id)
    and room_sessions.id = sqlc.arg(session_id)
returning
    id,
    tenant_id,
    room_id,
    session_id,
    status,
    storage_provider,
    storage_key,
    metadata,
    updated_at,
    created_at;

-- name: GetTenantRecording :one
select
    id,
    tenant_id,
    room_id,
    session_id,
    status,
    storage_provider,
    storage_key,
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
    room_id,
    session_id,
    status,
    storage_provider,
    storage_key,
    metadata,
    updated_at,
    created_at
from recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        sqlc.narg(session_id)::uuid is null
        or session_id = sqlc.narg(session_id)::uuid
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

-- name: UpdateTenantRecording :one
update recordings
set
    status = case
        when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text
        else status
    end,
    storage_provider = case
        when sqlc.arg(storage_provider_set)::boolean then sqlc.arg(storage_provider)::text
        else storage_provider
    end,
    storage_key = case
        when sqlc.arg(storage_key_set)::boolean then sqlc.narg(storage_key)::text
        else storage_key
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    tenant_id,
    room_id,
    session_id,
    status,
    storage_provider,
    storage_key,
    metadata,
    updated_at,
    created_at;
