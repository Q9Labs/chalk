-- +goose Up
create index tenants_created_at_id_idx on tenants(created_at desc, id desc);

-- +goose Down
drop index tenants_created_at_id_idx;
