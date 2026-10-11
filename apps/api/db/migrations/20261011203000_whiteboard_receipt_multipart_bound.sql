-- +goose NO TRANSACTION
-- +goose Up
-- The receipt must accept every bounded multipart update accepted by Sync.
-- NOT VALID avoids scanning retained receipts while holding the write lock.
alter table sync_whiteboard_operation_receipts
    drop constraint sync_whiteboard_operation_receipts_check1,
    add constraint sync_whiteboard_operation_receipts_check1 check (
        (
            operation_name = 'submit_update'
            and jsonb_typeof(event_elements) = 'array'
            and event_presenting is null
            and event_encoded_bytes between 2 and 16777216
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
    ) not valid;

alter table sync_whiteboard_operation_receipts
    validate constraint sync_whiteboard_operation_receipts_check1;

-- +goose Down
-- This fails atomically if a retained receipt exceeds the old bound.
alter table sync_whiteboard_operation_receipts
    drop constraint sync_whiteboard_operation_receipts_check1,
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
