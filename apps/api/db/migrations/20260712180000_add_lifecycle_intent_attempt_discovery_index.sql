-- +goose Up
alter table sync_lifecycle_intents
    add column next_attempt_at timestamptz not null default now();

drop index sync_lifecycle_intents_pending_idx;

create index sync_lifecycle_intents_pending_attempt_idx
    on sync_lifecycle_intents(next_attempt_at, attempt_count, created_at, lifecycle_intent_id)
    where status = 'pending';

-- +goose Down
drop index sync_lifecycle_intents_pending_attempt_idx;

alter table sync_lifecycle_intents
    drop column next_attempt_at;

create index sync_lifecycle_intents_pending_idx
    on sync_lifecycle_intents(created_at, lifecycle_intent_id)
    where status = 'pending';
