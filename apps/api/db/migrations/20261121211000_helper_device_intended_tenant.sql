-- +goose Up
alter table helper_device_requests add column intended_tenant_id uuid;

-- +goose Down
alter table helper_device_requests drop column intended_tenant_id;
