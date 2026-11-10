-- +goose Up
-- The Space's own choice of media plane. Null means inherit: the Tenant default, then the platform
-- default. The previous release never reads this column and keeps reading media_plane, which the
-- new release still writes, so a rollback behaves.
alter table spaces
    add column media_plane_setting text
        check (media_plane_setting in ('cf_sfu', 'chalk_sfu'));

-- Any tenant could write tenants.default_media_plane before operators owned it, with no check on the
-- value. Existing rows start unapproved, so a legacy chalk_sfu never selects the own SFU until an
-- operator writes it again, and an unknown value is ignored by the resolver.
alter table tenants
    add column default_media_plane_approved boolean not null default false;

-- +goose Down
alter table tenants drop column default_media_plane_approved;
alter table spaces drop column media_plane_setting;
