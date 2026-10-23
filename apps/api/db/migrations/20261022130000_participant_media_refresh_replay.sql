-- +goose Up
SET LOCAL lock_timeout = '5s';
create table participant_media_refreshes (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    participant_generation bigint not null check (participant_generation > 0),
    request_hash bytea not null check (octet_length(request_hash) = 32),
    connection_id text not null,
    response_ciphertext bytea not null,
    created_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id, participant_id, participant_generation, request_hash),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete cascade
);

-- +goose Down
drop table participant_media_refreshes;
