-- name: CreateAPIKey :one
insert into api_keys (
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    expires_at
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(name),
    sqlc.arg(scopes),
    sqlc.arg(key_hash),
    sqlc.arg(key_prefix),
    sqlc.narg(created_by_user_id),
    sqlc.arg(expires_at)
)
returning
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    last_used_ip,
    last_used_at,
    revoked_at,
    expires_at,
    updated_at,
    created_at;

-- name: ReserveAPIKeyMutation :one
insert into api_key_mutation_requests (
    tenant_id,
    operation,
    request_key,
    request_fingerprint
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(operation),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint)
)
on conflict (tenant_id, operation, request_key) do nothing
returning tenant_id, operation, request_key, request_fingerprint, api_key_id, created_at;

-- name: GetAPIKeyMutation :one
select tenant_id, operation, request_key, request_fingerprint, api_key_id, created_at
from api_key_mutation_requests
where tenant_id = sqlc.arg(tenant_id)
  and operation = sqlc.arg(operation)
  and request_key = sqlc.arg(request_key);

-- name: LinkAPIKeyMutation :exec
update api_key_mutation_requests
set api_key_id = sqlc.arg(api_key_id)
where tenant_id = sqlc.arg(tenant_id)
  and operation = sqlc.arg(operation)
  and request_key = sqlc.arg(request_key)
  and api_key_id is null;

-- name: GetTenantAPIKey :one
select
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    last_used_ip,
    last_used_at,
    revoked_at,
    expires_at,
    updated_at,
    created_at
from api_keys
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: GetActiveAPIKeyByPrefix :one
select
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    last_used_ip,
    last_used_at,
    revoked_at,
    expires_at,
    updated_at,
    created_at
from api_keys
where
    key_prefix = sqlc.arg(key_prefix)
    and revoked_at is null
    and expires_at > now();

-- name: ListTenantAPIKeys :many
select
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    last_used_ip,
    last_used_at,
    revoked_at,
    expires_at,
    updated_at,
    created_at
from api_keys
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

-- name: RotateActiveAPIKey :one
update api_keys
set
    key_hash = sqlc.arg(key_hash),
    key_prefix = sqlc.arg(key_prefix),
    expires_at = sqlc.arg(expires_at),
    last_used_ip = null,
    last_used_at = null,
    updated_at = sqlc.arg(rotated_at)
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
    and revoked_at is null
    and expires_at > sqlc.arg(rotated_at)
returning
    id,
    tenant_id,
    name,
    scopes,
    key_hash,
    key_prefix,
    created_by_user_id,
    last_used_ip,
    last_used_at,
    revoked_at,
    expires_at,
    updated_at,
    created_at;

-- name: RevokeActiveAPIKey :one
update api_keys
set
    revoked_at = sqlc.arg(revoked_at),
    updated_at = sqlc.arg(revoked_at)
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
    and revoked_at is null
    and expires_at > sqlc.arg(revoked_at)
returning id;

-- name: TouchActiveAPIKeyLastUsed :exec
update api_keys
set
    last_used_ip = case
        when last_used_at is null or last_used_at <= sqlc.arg(used_at) then sqlc.narg(ip_address)
        else last_used_ip
    end,
    last_used_at = greatest(coalesce(last_used_at, sqlc.arg(used_at)), sqlc.arg(used_at)),
    updated_at = greatest(updated_at, sqlc.arg(used_at))
where
    id = sqlc.arg(id)
    and revoked_at is null
    and expires_at > sqlc.arg(used_at);
