-- +goose Up
create index users_created_at_id_idx on users(created_at desc, id desc);
create index memberships_tenant_created_at_id_idx on memberships(tenant_id, created_at desc, id desc);
create index memberships_user_id_idx on memberships(user_id);

-- +goose Down
drop index memberships_user_id_idx;
drop index memberships_tenant_created_at_id_idx;
drop index users_created_at_id_idx;
