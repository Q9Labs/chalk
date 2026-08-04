-- name: ReserveTenantOnboarding :one
insert into tenant_onboarding_requests (
    account_id,
    request_key,
    request_fingerprint,
    tenant_id,
    tenant_access_id
) values (
    sqlc.arg(account_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(tenant_id),
    sqlc.arg(tenant_access_id)
)
on conflict (account_id, request_key) do nothing
returning account_id, request_key, request_fingerprint, tenant_id, tenant_access_id, created_at;

-- name: GetTenantOnboarding :one
select account_id, request_key, request_fingerprint, tenant_id, tenant_access_id, created_at
from tenant_onboarding_requests
where account_id = sqlc.arg(account_id)
  and request_key = sqlc.arg(request_key);

-- name: GetAccountTenantByOnboarding :one
select
    tenants.id,
    tenants.name,
    tenants.default_region,
    tenants.default_media_plane,
    tenants.media_plane_provider_config,
    tenants.ai_provider_config,
    tenants.storage_provider_config,
    tenants.logo_key,
    tenants.website,
    tenants.updated_at,
    tenants.created_at,
    memberships.id as tenant_access_id,
    memberships.user_id as account_id,
    memberships.role as access_role,
    memberships.updated_at as access_updated_at,
    memberships.created_at as access_created_at
from tenant_onboarding_requests
join tenants on tenants.id = tenant_onboarding_requests.tenant_id
join memberships on memberships.id = tenant_onboarding_requests.tenant_access_id
where tenant_onboarding_requests.account_id = sqlc.arg(account_id)
  and tenant_onboarding_requests.request_key = sqlc.arg(request_key);

-- name: ListAccountTenants :many
select
    tenants.id,
    tenants.name,
    tenants.default_region,
    tenants.default_media_plane,
    tenants.media_plane_provider_config,
    tenants.ai_provider_config,
    tenants.storage_provider_config,
    tenants.logo_key,
    tenants.website,
    tenants.updated_at,
    tenants.created_at,
    memberships.id as tenant_access_id,
    memberships.user_id as account_id,
    memberships.role as access_role,
    memberships.updated_at as access_updated_at,
    memberships.created_at as access_created_at
from memberships
join tenants on tenants.id = memberships.tenant_id
where memberships.user_id = sqlc.arg(account_id)
  and (
      not sqlc.arg(cursor_set)::boolean
      or (tenants.created_at, tenants.id) < (
          sqlc.arg(cursor_created_at)::timestamptz,
          sqlc.arg(cursor_id)::uuid
      )
  )
order by tenants.created_at desc, tenants.id desc
limit sqlc.arg(page_size)::integer;
