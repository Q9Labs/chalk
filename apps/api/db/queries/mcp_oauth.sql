-- name: CreateMCPOAuthClient :exec
insert into mcp_oauth_clients (id, client_id, client_name, redirect_uris)
values (sqlc.arg(id), sqlc.arg(client_id), sqlc.arg(client_name), sqlc.arg(redirect_uris));

-- name: GetMCPOAuthClientByPublicID :one
select id, client_id, client_name, redirect_uris, created_at
from mcp_oauth_clients
where client_id = sqlc.arg(client_id);

-- name: DeleteStaleMCPOAuthRegistrations :exec
with stale_requests as (
    delete from mcp_oauth_authorization_requests
    where expires_at < sqlc.arg(cutoff)
)
delete from mcp_oauth_clients c
where c.created_at < sqlc.arg(cutoff)
  and not exists (select 1 from mcp_oauth_grants g where g.client_id = c.id)
  and not exists (
      select 1 from mcp_oauth_authorization_requests r
      where r.client_id = c.id and r.expires_at >= sqlc.arg(cutoff)
  );

-- name: CreateMCPOAuthAuthorizationRequest :exec
insert into mcp_oauth_authorization_requests (
    request_hash, client_id, redirect_uri, state, code_challenge, scopes, resource, expires_at
) values (
    sqlc.arg(request_hash), sqlc.arg(client_id), sqlc.arg(redirect_uri), sqlc.narg(state),
    sqlc.arg(code_challenge), sqlc.arg(scopes), sqlc.arg(resource), sqlc.arg(expires_at)
);

-- name: GetOpenMCPOAuthAuthorizationRequest :one
select r.request_hash, r.client_id as client_row_id, c.client_id, c.client_name, r.redirect_uri,
       r.state, r.code_challenge, r.scopes, r.resource, r.expires_at
from mcp_oauth_authorization_requests r
join mcp_oauth_clients c on c.id = r.client_id
where r.request_hash = sqlc.arg(request_hash)
  and r.decided_at is null
  and r.expires_at > sqlc.arg(now);

-- name: DecideMCPOAuthAuthorizationRequest :one
update mcp_oauth_authorization_requests
set decided_at = sqlc.arg(now)
where request_hash = sqlc.arg(request_hash)
  and decided_at is null
  and expires_at > sqlc.arg(now)
returning client_id as client_row_id, redirect_uri, state, code_challenge, scopes, resource;

-- name: CreateMCPOAuthGrant :exec
insert into mcp_oauth_grants (id, tenant_id, client_id, scopes, resource, approved_by_service_id)
values (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(client_id), sqlc.arg(scopes), sqlc.arg(resource), sqlc.arg(approved_by_service_id));

-- name: CreateMCPOAuthCode :exec
insert into mcp_oauth_codes (code_hash, grant_id, redirect_uri, code_challenge, expires_at)
values (sqlc.arg(code_hash), sqlc.arg(grant_id), sqlc.arg(redirect_uri), sqlc.arg(code_challenge), sqlc.arg(expires_at));

-- name: ConsumeMCPOAuthCode :one
update mcp_oauth_codes
set consumed_at = sqlc.arg(now)
where code_hash = sqlc.arg(code_hash)
  and consumed_at is null
  and expires_at > sqlc.arg(now)
returning grant_id, redirect_uri, code_challenge;

-- name: GetMCPOAuthCodeGrant :one
select grant_id, consumed_at
from mcp_oauth_codes
where code_hash = sqlc.arg(code_hash);

-- name: GetMCPOAuthGrant :one
select g.id, g.tenant_id, g.client_id as client_row_id, c.client_id, g.scopes, g.resource, g.revoked_at
from mcp_oauth_grants g
join mcp_oauth_clients c on c.id = g.client_id
where g.id = sqlc.arg(id);

-- name: CreateMCPOAuthToken :exec
insert into mcp_oauth_tokens (token_hash, kind, grant_id, resource, expires_at)
values (sqlc.arg(token_hash), sqlc.arg(kind), sqlc.arg(grant_id), sqlc.arg(resource), sqlc.arg(expires_at));

-- name: ConsumeMCPOAuthRefreshToken :one
update mcp_oauth_tokens
set used_at = sqlc.arg(now)
where token_hash = sqlc.arg(token_hash)
  and kind = 'refresh'
  and used_at is null
  and expires_at > sqlc.arg(now)
returning grant_id, resource;

-- name: GetMCPOAuthRefreshToken :one
select grant_id, used_at, expires_at
from mcp_oauth_tokens
where token_hash = sqlc.arg(token_hash) and kind = 'refresh';

-- name: DeleteExpiredMCPOAuthGrantRows :exec
with expired_tokens as (
    delete from mcp_oauth_tokens t
    where t.grant_id = sqlc.arg(grant_id) and t.expires_at < sqlc.arg(cutoff)
)
delete from mcp_oauth_codes c
where c.grant_id = sqlc.arg(grant_id) and c.expires_at < sqlc.arg(cutoff);

-- name: AuthenticateMCPOAuthAccessToken :one
select g.id as grant_id, g.tenant_id, g.client_id as client_row_id, g.scopes, g.resource as grant_resource, t.resource as token_resource
from mcp_oauth_tokens t
join mcp_oauth_grants g on g.id = t.grant_id
where t.token_hash = sqlc.arg(token_hash)
  and t.kind = 'access'
  and t.expires_at > sqlc.arg(now)
  and g.revoked_at is null;

-- name: TouchMCPOAuthGrant :exec
update mcp_oauth_grants
set last_used_at = sqlc.arg(now)
where id = sqlc.arg(id)
  and (last_used_at is null or last_used_at < sqlc.arg(now)::timestamptz - interval '1 minute');

-- name: RevokeMCPOAuthGrant :execrows
update mcp_oauth_grants
set revoked_at = sqlc.arg(now)
where id = sqlc.arg(id) and revoked_at is null;

-- name: RevokeTenantMCPOAuthGrant :execrows
update mcp_oauth_grants
set revoked_at = sqlc.arg(now)
where id = sqlc.arg(id) and tenant_id = sqlc.arg(tenant_id) and revoked_at is null;

-- A Tenant keeps its newest 100 connected apps, the number the dashboard lists,
-- so every active connection stays visible and revocable.
-- name: RevokeMCPOAuthGrantsBeyondLimit :exec
update mcp_oauth_grants g
set revoked_at = sqlc.arg(now)
where g.tenant_id = sqlc.arg(tenant_id) and g.revoked_at is null
  and g.id not in (
    select newest.id from mcp_oauth_grants newest
    where newest.tenant_id = sqlc.arg(tenant_id) and newest.revoked_at is null
    order by newest.created_at desc, newest.id
    limit 100
  );

-- name: FindMCPOAuthGrantByToken :one
select t.grant_id, c.client_id
from mcp_oauth_tokens t
join mcp_oauth_grants g on g.id = t.grant_id
join mcp_oauth_clients c on c.id = g.client_id
where t.token_hash = sqlc.arg(token_hash);

-- name: ListTenantMCPOAuthGrants :many
select g.id, c.client_id, c.client_name, g.scopes, g.resource, g.last_used_at, g.created_at
from mcp_oauth_grants g
join mcp_oauth_clients c on c.id = g.client_id
where g.tenant_id = sqlc.arg(tenant_id) and g.revoked_at is null
order by g.created_at desc, g.id
limit 100;
