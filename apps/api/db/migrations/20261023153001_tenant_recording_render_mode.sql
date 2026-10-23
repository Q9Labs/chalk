-- +goose Up
-- Existing and new Tenants opt in to automatic MP4 rendering explicitly.
alter table tenants add column recording_render_mode text not null default 'on_demand'
    check (recording_render_mode in ('on_demand', 'automatic'));

-- +goose Down
alter table tenants drop column recording_render_mode;
