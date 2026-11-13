-- name: CreateEpisode :one
insert into episodes (
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot
) select
    sqlc.arg(id),
    sqlc.arg(status),
    sqlc.narg(metadata),
    spaces.id,
    spaces.tenant_id,
    sqlc.narg(created_by_user_id),
    sqlc.narg(started_at),
    sqlc.narg(ended_at),
    jsonb_build_object(
        'roles', coalesce((
            select jsonb_object_agg(role.name, to_jsonb(role.capabilities))
            from space_roles role
            where role.tenant_id = spaces.tenant_id and role.space_id = spaces.id
        ), '{}'::jsonb),
        'admission_policy', spaces.admission_policy,
        'default_episode_duration_seconds', spaces.default_episode_duration_seconds,
        'maximum_episode_duration_seconds', spaces.maximum_episode_duration_seconds,
        'linger_window_seconds', spaces.linger_window_seconds
    )
from spaces
where
    spaces.tenant_id = sqlc.arg(tenant_id)
    and spaces.id = sqlc.arg(space_id)
    and spaces.archived_at is null
for update
returning
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at;

-- name: GetTenantEpisode :one
select
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(id);

-- name: ListTenantEpisodes :many
select
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (created_at, id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantEpisode :one
update episodes
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
    end_reason = case
        when sqlc.arg(end_reason_set)::boolean then sqlc.narg(end_reason)::text
        else end_reason
    end,
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(id)
returning
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    ended_at,
    config_snapshot,
    end_reason,
    deadline_at,
    deadline_generation,
    updated_at,
    created_at;
