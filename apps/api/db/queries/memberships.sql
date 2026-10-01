-- name: CreateMembership :one
with created_membership as (
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
    created_at
)
select
    created_membership.id,
    created_membership.tenant_id,
    created_membership.user_id,
    created_membership.role,
    created_membership.updated_at,
    created_membership.created_at,
    users.name as user_name,
    users.email as user_email
from created_membership
join users on users.id = created_membership.user_id;

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
    memberships.id,
    memberships.tenant_id,
    memberships.user_id,
    memberships.role,
    memberships.updated_at,
    memberships.created_at,
    users.name as user_name,
    users.email as user_email
from memberships
join users on users.id = memberships.user_id
where
    memberships.tenant_id = sqlc.arg(tenant_id)
    and (
        not sqlc.arg(cursor_set)::boolean
        or (memberships.created_at, memberships.id) < (
            sqlc.arg(cursor_created_at)::timestamptz,
            sqlc.arg(cursor_id)::uuid
        )
    )
order by memberships.created_at desc, memberships.id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantMembership :one
with updated_membership as (
update memberships
set
    role = sqlc.arg(role),
    updated_at = now()
where
    memberships.tenant_id = sqlc.arg(tenant_id)
    and memberships.id = sqlc.arg(id)
returning
    memberships.id,
    memberships.tenant_id,
    memberships.user_id,
    memberships.role,
    memberships.updated_at,
    memberships.created_at
)
select
    updated_membership.id,
    updated_membership.tenant_id,
    updated_membership.user_id,
    updated_membership.role,
    updated_membership.updated_at,
    updated_membership.created_at,
    users.name as user_name,
    users.email as user_email
from updated_membership
join users on users.id = updated_membership.user_id;
