-- +goose Up
create table sync_media_pauses (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null,
    source text not null,
    publication_id text not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, episode_id, participant_id, source),
    foreign key (tenant_id, space_id, episode_id)
        references sync_episode_control(tenant_id, space_id, episode_id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id, participant_generation)
        references participants(tenant_id, space_id, episode_id, id, generation)
        on delete cascade,
    check (participant_generation > 0),
    check (source in ('microphone', 'camera')),
    check (octet_length(publication_id) between 1 and 256)
);

-- +goose Down
-- A paused publication must not appear active after a coordinator restart.
-- Preserve this durable state until its Episode is cleaned up.
-- +goose StatementBegin
do $$
begin
    raise exception '20260929160000_sync_media_pauses is irreversible';
end;
$$;
-- +goose StatementEnd
