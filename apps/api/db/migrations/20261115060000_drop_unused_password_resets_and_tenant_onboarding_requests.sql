-- +goose Up
-- No code reads or writes either table: #248 removed the writers, and the running release never names them.
-- Rows were exported before the drop (password_resets: 3 expired rows; tenant_onboarding_requests: 7 rows).
-- chalk:removed-in #248
SET LOCAL lock_timeout = '5s';
drop table if exists password_resets;
drop table if exists tenant_onboarding_requests;

-- +goose Down
SET LOCAL lock_timeout = '5s';
create table tenant_onboarding_requests (
    account_id uuid not null references users(id),
    request_key text not null,
    request_fingerprint bytea not null,
    tenant_id uuid not null references tenants(id) deferrable initially deferred,
    tenant_access_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (account_id, request_key),
    unique (tenant_id),
    unique (tenant_access_id),
    constraint tenant_onboarding_requests_key_check
        check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    constraint tenant_onboarding_requests_fingerprint_check
        check (octet_length(request_fingerprint) = 32)
);
create index tenant_onboarding_requests_created_at_idx
    on tenant_onboarding_requests(created_at desc);

create table password_resets (
    account_id uuid primary key references users(id) on delete cascade,
    token_hash text not null unique,
    expires_at timestamptz not null,
    used_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now()
);
create index password_resets_expires_at_idx on password_resets(expires_at);
