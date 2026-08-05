-- +goose Up

-- Mutation reservations deliberately contain no credential material. A
-- request fingerprint makes retries deterministic while the nullable resource
-- id lets the reservation be inserted before the API-key transaction creates
-- the resource. A replay can therefore return metadata without ever replaying
-- the one-time secret.
create table api_key_mutation_requests (
    tenant_id uuid not null references tenants(id),
    operation text not null check (operation in ('create', 'rotate')),
    request_key text not null,
    request_fingerprint bytea not null,
    api_key_id uuid references api_keys(id),
    created_at timestamptz not null default now(),
    primary key (tenant_id, operation, request_key)
);

create index api_key_mutation_requests_resource_idx
    on api_key_mutation_requests (tenant_id, api_key_id)
    where api_key_id is not null;

-- +goose Down

drop table if exists api_key_mutation_requests;
