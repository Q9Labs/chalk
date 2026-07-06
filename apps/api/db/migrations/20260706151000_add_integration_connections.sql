-- +goose Up
create table integration_connections (
    id uuid primary key,
    tenant_id uuid not null references tenants(id),
    user_id uuid not null references users(id),
    provider text not null,
    service text not null,
    external_account_ref text not null,
    external_auth_config_ref text,
    status text not null,
    account_label text,
    account_email text,
    scopes text[] not null default '{}',
    metadata jsonb,
    connected_at timestamptz,
    expires_at timestamptz,
    last_used_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    unique (tenant_id, provider, service, external_account_ref)
);

create index integration_connections_tenant_user_service_idx
    on integration_connections(tenant_id, user_id, service, created_at desc, id desc);

create index integration_connections_tenant_provider_service_idx
    on integration_connections(tenant_id, provider, service, created_at desc, id desc);

create index integration_connections_tenant_status_idx
    on integration_connections(tenant_id, status, created_at desc, id desc);

create index integration_connections_tenant_created_at_id_idx
    on integration_connections(tenant_id, created_at desc, id desc);

-- +goose Down
drop table integration_connections;
