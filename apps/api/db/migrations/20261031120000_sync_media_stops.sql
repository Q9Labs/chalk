-- +goose Up
-- A host stop (mute, camera stop, screen stop) kept until a newer host stop for the same participant and source replaces it.
-- Sync projects it as the off reason "host" so a client that missed the stop event can still see it.
create table sync_media_stops (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    revision bigint not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete cascade,
    check (participant_generation > 0),
    check (source in ('microphone', 'camera', 'screen')),
    check (revision > 0)
);

-- +goose Down
drop table sync_media_stops;
