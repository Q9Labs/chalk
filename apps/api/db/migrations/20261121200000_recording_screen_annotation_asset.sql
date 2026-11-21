-- +goose Up
alter table recording_presentation_assets
    drop constraint recording_presentation_assets_asset_kind_check,
    add constraint recording_presentation_assets_asset_kind_check
        check (asset_kind in ('logo', 'avatar', 'chat_attachment', 'whiteboard_state', 'whiteboard_file', 'font', 'screen_annotation'));

-- +goose Down
-- Do not invalidate or delete already-frozen recording assets on rollback.
alter table recording_presentation_assets
    drop constraint recording_presentation_assets_asset_kind_check,
    add constraint recording_presentation_assets_asset_kind_check
        check (asset_kind in ('logo', 'avatar', 'chat_attachment', 'whiteboard_state', 'whiteboard_file', 'font')) not valid;
