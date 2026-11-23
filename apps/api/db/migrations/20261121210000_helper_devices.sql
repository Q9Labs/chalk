-- +goose Up
create table helper_devices (
    id uuid primary key,
    tenant_id uuid not null references tenants(id) on delete cascade,
    name text not null,
    public_key text not null,
    credential_hash bytea not null unique,
    registered_at timestamptz not null default now(),
    revoked_at timestamptz
);
create index helper_devices_tenant_idx on helper_devices (tenant_id, registered_at desc);

create table helper_device_requests (
    id uuid primary key,
    code_hash bytea not null unique,
    poll_hash bytea not null unique,
    name text not null,
    public_key text not null,
    credential_hash bytea not null,
    device_id uuid references helper_devices(id) on delete cascade,
    expires_at timestamptz not null,
    next_poll_at timestamptz not null default now(),
    approved_share jsonb,
    approval_expires_at timestamptz,
    check ((approved_share is null) = (approval_expires_at is null))
);
create index helper_device_requests_expiry_idx on helper_device_requests (expires_at);

-- +goose Down
drop table helper_device_requests;
drop table helper_devices;
