-- +goose Up
-- sync_media_pauses holds the pauses in force now and loses a row on resume, so a pause that never
-- resumed left no trace. This table keeps one row per pause: resumed_at stays null until the Participant
-- is resumed, so "paused and never resumed" is a query. Sync writes both rows in the transaction that
-- changes sync_media_pauses. The previous release ignores the table, so it stays runnable.
create table sync_media_pause_history (
    id bigint generated always as identity primary key,
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    source text not null check (source in ('microphone', 'camera', 'screen')),
    publication_id text not null,
    paused_at timestamptz not null default now(),
    resumed_at timestamptz,
    check (resumed_at is null or resumed_at >= paused_at),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade
);

-- At most one open pause per Participant and source.
create unique index sync_media_pause_history_open
    on sync_media_pause_history (tenant_id, episode_id, participant_id, source)
    where resumed_at is null;

-- +goose Down
drop table sync_media_pause_history;
