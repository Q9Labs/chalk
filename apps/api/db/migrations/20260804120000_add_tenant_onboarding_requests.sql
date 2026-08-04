-- +goose Up
create table tenant_onboarding_requests (
    account_id uuid not null references users(id),
    request_key text not null,
    request_fingerprint bytea not null,
    tenant_id uuid not null references tenants(id) deferrable initially deferred,
    tenant_access_id uuid not null references memberships(id) deferrable initially deferred,
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

-- +goose Down
drop table tenant_onboarding_requests;
