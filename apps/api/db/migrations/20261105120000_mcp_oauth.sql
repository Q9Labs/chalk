-- +goose Up
-- Self-hosted OAuth for the hosted MCP server. Every bearer value (authorization
-- request handle, code, access token, refresh token) is stored as a SHA-256 hash.
create table mcp_oauth_clients (
    id uuid primary key,
    client_id text not null unique,
    client_name text not null,
    redirect_uris text[] not null,
    created_at timestamptz not null default now(),
    constraint mcp_oauth_clients_redirect_uris_count_check
        check (cardinality(redirect_uris) between 1 and 5)
);

create table mcp_oauth_authorization_requests (
    request_hash text primary key,
    client_id uuid not null references mcp_oauth_clients(id),
    redirect_uri text not null,
    -- False when the client omitted redirect_uri and the registered one was used (RFC 6749 4.1.3).
    redirect_uri_supplied boolean not null,
    state text,
    code_challenge text not null,
    scopes text[] not null,
    resource text not null,
    expires_at timestamptz not null,
    decided_at timestamptz,
    created_at timestamptz not null default now()
);

-- A grant is one connected app: a tenant's consent for one client and resource.
create table mcp_oauth_grants (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    client_id uuid not null references mcp_oauth_clients(id),
    scopes text[] not null,
    resource text not null,
    approved_by_service_id text not null,
    last_used_at timestamptz,
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create index mcp_oauth_grants_tenant_idx
    on mcp_oauth_grants (tenant_id, created_at desc)
    where revoked_at is null;

create table mcp_oauth_codes (
    code_hash text primary key,
    grant_id uuid not null references mcp_oauth_grants(id) on delete cascade,
    redirect_uri text not null,
    -- False when the client omitted redirect_uri and the registered one was used (RFC 6749 4.1.3).
    redirect_uri_supplied boolean not null,
    code_challenge text not null,
    expires_at timestamptz not null,
    consumed_at timestamptz
);

create index mcp_oauth_codes_grant_idx on mcp_oauth_codes (grant_id);

create table mcp_oauth_tokens (
    token_hash text primary key,
    kind text not null check (kind in ('access', 'refresh')),
    grant_id uuid not null references mcp_oauth_grants(id) on delete cascade,
    resource text not null,
    expires_at timestamptz not null,
    used_at timestamptz,
    created_at timestamptz not null default now()
);

create index mcp_oauth_tokens_grant_idx on mcp_oauth_tokens (grant_id);
create index mcp_oauth_tokens_expiry_idx on mcp_oauth_tokens (expires_at);

-- +goose Down
drop table mcp_oauth_tokens;
drop table mcp_oauth_codes;
drop table mcp_oauth_grants;
drop table mcp_oauth_authorization_requests;
drop table mcp_oauth_clients;
