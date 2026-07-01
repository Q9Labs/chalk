-- name: CreateMembership :one
insert into memberships (
    id,
    tenant_id,
    user_id,
    role
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(user_id),
    sqlc.arg(role)
)
returning
    id,
    tenant_id,
    user_id,
    role,
    updated_at,
    created_at;

-- name: GetTenantMembershipForUser :one
select
    id,
    tenant_id,
    user_id,
    role,
    updated_at,
    created_at
from memberships
where
    tenant_id = sqlc.arg(tenant_id)
    and user_id = sqlc.arg(user_id);

-- name: ListTenantMemberships :many
select
    id,
    tenant_id,
    user_id,
    role,
    updated_at,
    created_at
from memberships
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

-- name: UpdateTenantMembership :one
update memberships
set
    role = sqlc.arg(role),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    tenant_id,
    user_id,
    role,
    updated_at,
    created_at;
