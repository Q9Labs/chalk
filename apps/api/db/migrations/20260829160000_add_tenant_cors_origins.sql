-- +goose Up
alter table tenants
    add column cors_allowed_origins text[] not null default '{}',
    add constraint tenants_cors_allowed_origins_count_check
        check (cardinality(cors_allowed_origins) <= 32);

-- +goose Down
alter table tenants
    drop constraint tenants_cors_allowed_origins_count_check,
    drop column cors_allowed_origins;
