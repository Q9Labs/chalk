-- +goose Up
create index participants_sync_active_session_capacity_idx
    on participants(tenant_id, room_id, session_id)
    where status in ('joining', 'active', 'leaving');

create index sync_lifecycle_intents_session_pending_idx
    on sync_lifecycle_intents(tenant_id, session_id)
    where status = 'pending';

alter table sync_session_control
    add column retention_checkpoint_revision bigint,
    add column retention_checkpoint_state_digest bytea,
    add column retention_checkpoint_event_count bigint,
    add column retention_cleaned_at timestamptz,
    add column retention_deleted_event_rows bigint not null default 0,
    add column retention_deleted_event_bytes bigint not null default 0,
    add column retention_deleted_receipt_rows bigint not null default 0,
    add column retention_deleted_receipt_bytes bigint not null default 0,
    add column retention_deleted_lifecycle_intent_rows bigint not null default 0,
    add column retention_deleted_lifecycle_intent_bytes bigint not null default 0,
    add constraint sync_session_control_retention_checkpoint_check
        check (
            (
                retention_cleaned_at is null
                and retention_checkpoint_revision is null
                and retention_checkpoint_state_digest is null
                and retention_checkpoint_event_count is null
                and retention_deleted_event_rows = 0
                and retention_deleted_event_bytes = 0
                and retention_deleted_receipt_rows = 0
                and retention_deleted_receipt_bytes = 0
                and retention_deleted_lifecycle_intent_rows = 0
                and retention_deleted_lifecycle_intent_bytes = 0
            )
            or (
                retention_cleaned_at is not null
                and retention_checkpoint_revision is not null
                and retention_checkpoint_revision >= 0
                and retention_checkpoint_state_digest is not null
                and octet_length(retention_checkpoint_state_digest) = 32
                and retention_checkpoint_event_count is not null
                and retention_checkpoint_event_count = retention_checkpoint_revision
                and retention_deleted_event_rows = retention_checkpoint_event_count
                and retention_deleted_event_bytes >= 0
                and retention_deleted_receipt_rows >= 0
                and retention_deleted_receipt_bytes >= 0
                and retention_deleted_lifecycle_intent_rows >= 0
                and retention_deleted_lifecycle_intent_bytes >= 0
            )
        );

-- +goose Down
alter table sync_session_control
    drop constraint sync_session_control_retention_checkpoint_check,
    drop column retention_deleted_lifecycle_intent_bytes,
    drop column retention_deleted_lifecycle_intent_rows,
    drop column retention_deleted_receipt_bytes,
    drop column retention_deleted_receipt_rows,
    drop column retention_deleted_event_bytes,
    drop column retention_deleted_event_rows,
    drop column retention_cleaned_at,
    drop column retention_checkpoint_event_count,
    drop column retention_checkpoint_state_digest,
    drop column retention_checkpoint_revision;

drop index sync_lifecycle_intents_session_pending_idx;
drop index participants_sync_active_session_capacity_idx;
