-- +goose Up
create table participant_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    participant_generation bigint not null check (participant_generation > 0),
    expires_at timestamptz not null,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

create index participant_presence_leases_expiry_idx on participant_presence_leases(expires_at);

-- +goose Down
drop table participant_presence_leases;
