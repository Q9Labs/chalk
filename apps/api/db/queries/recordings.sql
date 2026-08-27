-- name: CreateRecording :one
insert into recordings (
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    storage_key,
    metadata
) select
    sqlc.arg(id),
    episodes.tenant_id,
    episodes.space_id,
    episodes.id,
    sqlc.arg(status),
    sqlc.arg(storage_provider),
    sqlc.narg(storage_key),
    sqlc.narg(metadata)
from episodes
where
    episodes.tenant_id = sqlc.arg(tenant_id)
    and episodes.space_id = sqlc.arg(space_id)
    and episodes.id = sqlc.arg(episode_id)
returning
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
    created_at;

-- name: MaterializeRecording :one
insert into recordings (
    id,
    tenant_id,
    space_id,
    episode_id,
    status,
    storage_provider,
    metadata
) select
    sqlc.arg(id),
    episodes.tenant_id,
    episodes.space_id,
    episodes.id,
    'pending',
    'r2',
    sqlc.narg(metadata)
from episodes
where
    episodes.tenant_id = sqlc.arg(tenant_id)
    and episodes.space_id = sqlc.arg(space_id)
    and episodes.id = sqlc.arg(episode_id)
on conflict (id) do update
set updated_at = recordings.updated_at
where recordings.tenant_id = excluded.tenant_id
  and recordings.space_id = excluded.space_id
  and recordings.episode_id = excluded.episode_id
  and recordings.status in ('pending', 'processing')
returning
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
    created_at;

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
    created_at;
