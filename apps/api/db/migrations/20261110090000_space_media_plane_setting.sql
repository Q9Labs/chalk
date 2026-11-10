-- +goose Up
-- The Space's own choice of media plane. Null means inherit: the Tenant default, then the platform
-- default. The previous release never reads this column and keeps reading media_plane, which the
-- new release still writes, so a rollback behaves.
alter table spaces
    add column media_plane_setting text
        check (media_plane_setting in ('cf_sfu', 'chalk_sfu'));

-- +goose Down
alter table spaces drop column media_plane_setting;
