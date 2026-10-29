-- +goose Up
alter table sync_whiteboard_scenes
    add column presenting_episode_id uuid;

alter table sync_whiteboard_operation_receipts
    add column event_presenting boolean,
    drop constraint if exists sync_whiteboard_operation_receipts_operation_name_check,
    drop constraint if exists sync_whiteboard_operation_receipts_operation_name_check1,
    drop constraint if exists sync_whiteboard_operation_receipts_check,
    drop constraint if exists sync_whiteboard_operation_receipts_check1,
    add constraint sync_whiteboard_operation_receipts_operation_name_check1
        check (operation_name in ('submit_update', 'clear', 'set_draw_permission', 'set_presentation')),
    add constraint sync_whiteboard_operation_receipts_check1 check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_presenting is null
            and event_encoded_bytes between 2 and 262144
        )
        or (
            operation_name = 'set_presentation'
            and event_elements is null
            and event_presenting is not null
            and event_encoded_bytes = 0
        )
        or (
            operation_name not in ('submit_update', 'set_presentation')
            and event_elements is null
            and event_presenting is null
            and event_encoded_bytes = 0
        )
    );

-- +goose Down
alter table sync_whiteboard_operation_receipts
    drop constraint if exists sync_whiteboard_operation_receipts_operation_name_check,
    drop constraint if exists sync_whiteboard_operation_receipts_operation_name_check1,
    drop constraint if exists sync_whiteboard_operation_receipts_check,
    drop constraint if exists sync_whiteboard_operation_receipts_check1;

delete from sync_whiteboard_operation_receipts
where operation_name = 'set_presentation';

alter table sync_whiteboard_operation_receipts
    add constraint sync_whiteboard_operation_receipts_operation_name_check1
        check (operation_name in ('submit_update', 'clear', 'set_draw_permission')),
    add constraint sync_whiteboard_operation_receipts_check1 check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_encoded_bytes between 2 and 262144
        )
        or (
            operation_name <> 'submit_update'
            and event_elements is null
            and event_encoded_bytes = 0
        )
    ),
    drop column event_presenting;

alter table sync_whiteboard_scenes
    drop column presenting_episode_id;
