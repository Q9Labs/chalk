-- +goose Up
-- Keep the columns and the setting witness for the previous API release.
-- Do not change Episode snapshots, recording references, or existing audit rows.
select set_config('chalk.plane_actor', 'migration', true);
select set_config('chalk.plane_reason', 'retire Cloudflare media', true);
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

-- +goose StatementBegin
create or replace function audit_media_plane_kill_switch()
returns trigger
language plpgsql
as $$
begin
    perform record_media_plane_change('kill_switch', null, null,
        case when old.paused then 'paused' else 'chalk_sfu' end,
        case when new.paused then 'paused' else 'chalk_sfu' end);
    return null;
end;
$$;
-- +goose StatementEnd

-- +goose Down
-- Do not send Spaces back to a retired service or overwrite later operator changes.
-- +goose StatementBegin
create or replace function audit_media_plane_kill_switch()
returns trigger
language plpgsql
as $$
begin
    perform record_media_plane_change('kill_switch', null, null,
        case when old.paused then 'cf_sfu' else 'inherit' end,
        case when new.paused then 'cf_sfu' else 'inherit' end);
    return null;
end;
$$;
-- +goose StatementEnd
