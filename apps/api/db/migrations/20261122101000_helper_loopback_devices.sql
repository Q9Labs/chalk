-- +goose Up
alter table helper_devices add column loopback boolean not null default false;
create unique index helper_loopback_devices_key_idx on helper_devices (tenant_id, public_key) where loopback;

-- +goose Down
delete from helper_devices where loopback;
drop index helper_loopback_devices_key_idx;
alter table helper_devices drop column loopback;
