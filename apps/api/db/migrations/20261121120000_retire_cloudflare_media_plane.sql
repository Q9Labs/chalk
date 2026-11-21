-- +goose Up
-- Keep the columns and the setting witness for the previous API release.
-- Do not change Episode snapshots, recording references, or audit history.
update spaces
set media_plane = 'chalk_sfu',
    media_plane_setting_written = case when media_plane_setting is not null then 'chalk_sfu' end,
    media_plane_setting_against = case when media_plane_setting is not null then 'chalk_sfu' end
where btrim(media_plane) in ('cf_sfu', 'cf_rtk')
   or media_plane_setting in ('cf_sfu', 'cf_rtk')
   or media_plane_setting_written in ('cf_sfu', 'cf_rtk');

select set_config('chalk.operator_write', 'on', true);
update tenants
set default_media_plane = 'chalk_sfu', default_media_plane_approved = true
where btrim(default_media_plane) in ('cf_sfu', 'cf_rtk');

-- +goose Down
-- Do not send Spaces back to a retired service or overwrite later operator changes.
select 1;
