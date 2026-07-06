-- name: CreateRoom :one
insert into rooms (
    id,
    name,
    tenant_id,
    status,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    created_by_user_id
) values (
    sqlc.arg(id),
    sqlc.arg(name),
    sqlc.arg(tenant_id),
    sqlc.arg(status),
    sqlc.arg(slug),
    sqlc.arg(media_plane),
    sqlc.narg(metadata),
    sqlc.narg(recurring_policy),
    sqlc.narg(created_by_user_id)
)
returning
    id,
    name,
    tenant_id,
    status,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    created_by_user_id,
    updated_at,
    created_at;

-- name: GetTenantRoom :one
select
    id,
    name,
    tenant_id,
    status,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    created_by_user_id,
    updated_at,
    created_at
from rooms
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: ListTenantRooms :many
select
    id,
    name,
    tenant_id,
    status,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    created_by_user_id,
    updated_at,
    created_at
from rooms
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantRoom :one
update rooms
set
    name = case
        when sqlc.arg(name_set)::boolean then sqlc.arg(name)::text
        else name
    end,
    status = case
        when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text
        else status
    end,
    slug = case
        when sqlc.arg(slug_set)::boolean then sqlc.arg(slug)::text
        else slug
    end,
    media_plane = case
        when sqlc.arg(media_plane_set)::boolean then sqlc.arg(media_plane)::text
        else media_plane
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    recurring_policy = case
        when sqlc.arg(recurring_policy_set)::boolean then sqlc.narg(recurring_policy)::jsonb
        else recurring_policy
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    name,
    tenant_id,
    status,
    slug,
    media_plane,
    metadata,
    recurring_policy,
    created_by_user_id,
    updated_at,
    created_at;

-- name: CreateRoomSession :one
insert into room_sessions (
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at
) select
    sqlc.arg(id),
    sqlc.arg(status),
    sqlc.narg(metadata),
    rooms.id,
    rooms.tenant_id,
    sqlc.narg(created_by_user_id),
    sqlc.narg(started_at),
    sqlc.narg(ended_at)
from rooms
where
    rooms.tenant_id = sqlc.arg(tenant_id)
    and rooms.id = sqlc.arg(room_id)
returning
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    updated_at,
    created_at;

-- name: GetTenantRoomSession :one
select
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    updated_at,
    created_at
from room_sessions
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(id);

-- name: ListTenantRoomSessions :many
select
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    updated_at,
    created_at
from room_sessions
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantRoomSession :one
update room_sessions
set
    status = case
        when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text
        else status
    end,
    metadata = case
        when sqlc.arg(metadata_set)::boolean then sqlc.narg(metadata)::jsonb
        else metadata
    end,
    started_at = case
        when sqlc.arg(started_at_set)::boolean then sqlc.narg(started_at)::timestamptz
        else started_at
    end,
    ended_at = case
        when sqlc.arg(ended_at_set)::boolean then sqlc.narg(ended_at)::timestamptz
        else ended_at
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(id)
returning
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    updated_at,
    created_at;
