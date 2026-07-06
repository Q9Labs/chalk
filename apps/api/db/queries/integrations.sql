-- name: CreateIntegrationConnection :one
insert into integration_connections (
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at
) values (
    sqlc.arg(id),
    sqlc.arg(tenant_id),
    sqlc.arg(user_id),
    sqlc.arg(provider),
    sqlc.arg(service),
    sqlc.arg(external_account_ref),
    sqlc.narg(external_auth_config_ref),
    sqlc.arg(status),
    sqlc.narg(account_label),
    sqlc.narg(account_email),
    sqlc.arg(scopes),
    sqlc.narg(metadata),
    sqlc.narg(connected_at),
    sqlc.narg(expires_at)
)
returning
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at;

-- name: GetIntegrationConnection :one
select
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at
from integration_connections
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id);

-- name: GetIntegrationConnectionByExternalRef :one
select
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at
from integration_connections
where
    tenant_id = sqlc.arg(tenant_id)
    and provider = sqlc.arg(provider)
    and service = sqlc.arg(service)
    and external_account_ref = sqlc.arg(external_account_ref);

-- name: ListIntegrationConnections :many
select
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at
from integration_connections
where
    tenant_id = sqlc.arg(tenant_id)
    and (
        not sqlc.arg(user_set)::boolean
        or user_id = sqlc.arg(user_id)::uuid
    )
    and (
        not sqlc.arg(provider_set)::boolean
        or provider = sqlc.arg(provider)::text
    )
    and (
        not sqlc.arg(service_set)::boolean
        or service = sqlc.arg(service)::text
    )
    and (
        not sqlc.arg(status_set)::boolean
        or status = sqlc.arg(status)::text
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

-- name: UpdateIntegrationConnection :one
update integration_connections
set
    status = sqlc.arg(status),
    account_label = sqlc.narg(account_label),
    account_email = sqlc.narg(account_email),
    scopes = sqlc.arg(scopes),
    metadata = sqlc.narg(metadata),
    connected_at = sqlc.narg(connected_at),
    expires_at = sqlc.narg(expires_at),
    revoked_at = sqlc.narg(revoked_at),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at;

-- name: MarkIntegrationConnectionUsed :one
update integration_connections
set
    last_used_at = now(),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
returning
    id,
    tenant_id,
    user_id,
    provider,
    service,
    external_account_ref,
    external_auth_config_ref,
    status,
    account_label,
    account_email,
    scopes,
    metadata,
    connected_at,
    expires_at,
    last_used_at,
    revoked_at,
    updated_at,
    created_at;
