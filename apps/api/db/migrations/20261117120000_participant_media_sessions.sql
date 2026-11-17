-- +goose Up
-- How each Participant session ended on the media node, saved when the Episode ends. The node's trail says the
-- same for 30 days; this row stays with the Participant.
create table participant_media_sessions (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    generation bigint not null check (generation > 0),
    connection_id text not null check (connection_id <> ''),
    cause text not null,
    outcome text not null,
    connected boolean not null,
    ended_at timestamptz not null,
    lifetime_ms bigint not null check (lifetime_ms >= 0),
    connect_ms bigint check (connect_ms >= 0),
    disconnects integer not null check (disconnects >= 0),
    outage_ms bigint not null check (outage_ms >= 0),
    primary key (tenant_id, episode_id, connection_id),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);
create index participant_media_sessions_participant_idx
    on participant_media_sessions(tenant_id, episode_id, participant_id, generation);

-- +goose Down
drop table participant_media_sessions;
