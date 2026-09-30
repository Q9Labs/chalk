-- +goose Up
alter table sync_media_pauses drop constraint sync_media_pauses_source_check;
alter table sync_media_pauses add constraint sync_media_pauses_source_check
    check (source in ('microphone', 'camera', 'screen'));

-- +goose Down
delete from sync_media_pauses where source = 'screen';
alter table sync_media_pauses drop constraint sync_media_pauses_source_check;
alter table sync_media_pauses add constraint sync_media_pauses_source_check
    check (source in ('microphone', 'camera'));
