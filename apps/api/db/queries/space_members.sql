-- name: ListSpaceRoles :many
select
    id,
    tenant_id,
    space_id,
    name,
    capabilities,
    updated_at,
    created_at
from space_roles
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
order by created_at, id;

-- name: CreateIdentity :one
insert into identities (
    id,
    tenant_id,
    kind,
    external_id,
    display_name,
    metadata
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(kind),
    sqlc.arg(external_id),
    sqlc.arg(display_name),
    sqlc.narg(metadata)
)
returning *;

-- name: GetTenantIdentityByExternalID :one
select *
from identities
where tenant_id = sqlc.arg(tenant_id)
  and external_id = sqlc.arg(external_id);

-- name: CreateSpaceRole :one
insert into space_roles (
    id,
    tenant_id,
    space_id,
    name,
    capabilities
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(name),
    sqlc.arg(capabilities)
)
returning *;

-- name: UpdateSpaceRole :one
update space_roles
set
    name = case when sqlc.arg(name_set)::boolean then sqlc.arg(name)::text else name end,
    capabilities = case when sqlc.arg(capabilities_set)::boolean then sqlc.arg(capabilities)::text[] else capabilities end,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and id = sqlc.arg(id)
returning *;

-- name: CreateSpaceMember :one
insert into space_members (
    id,
    tenant_id,
    space_id,
    identity_id,
    role_id
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(identity_id),
    sqlc.arg(role_id)
)
returning *;

-- name: GetSpaceMember :one
select *
from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and identity_id = sqlc.arg(identity_id);

-- name: ListSpaceMembers :many
select *
from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
order by created_at, id;

-- name: DeleteSpaceMember :exec
delete from space_members
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and identity_id = sqlc.arg(identity_id);
