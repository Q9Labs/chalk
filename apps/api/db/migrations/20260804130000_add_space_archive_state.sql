-- +goose Up
alter table spaces
    add column archived_at timestamptz;

create index spaces_tenant_archived_created_at_id_idx
    on spaces(tenant_id, archived_at, created_at desc, id desc);

create table space_create_requests (
    tenant_id uuid not null,
    request_key text not null,
    request_fingerprint bytea not null,
    space_id uuid not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, request_key),
    foreign key (tenant_id, space_id)
        references spaces(tenant_id, id)
        on delete no action
        deferrable initially deferred,
    check (request_key ~ '^[A-Za-z0-9_-]{16,128}$'),
    check (octet_length(request_fingerprint) = 32)
);

create index space_create_requests_space_idx
    on space_create_requests(tenant_id, space_id);

-- +goose Down
drop table if exists space_create_requests;
drop index if exists spaces_tenant_archived_created_at_id_idx;
alter table spaces
    drop column archived_at;
