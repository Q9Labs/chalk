-- +goose Up
alter table tenants
    drop column default_region,
    drop column ai_provider_config;

-- +goose Down
-- +goose StatementBegin
do $$ begin
    raise exception 'Dropped Tenant settings cannot be restored by a down migration; restore a backup instead';
end $$;
-- +goose StatementEnd
