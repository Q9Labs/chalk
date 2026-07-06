-- +goose Up
alter table tenants
    add column media_plane_provider_config jsonb,
    add column ai_provider_config jsonb,
    add column storage_provider_config jsonb;

-- +goose Down
alter table tenants
    drop column storage_provider_config,
    drop column ai_provider_config,
    drop column media_plane_provider_config;
