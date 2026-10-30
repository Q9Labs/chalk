-- +goose Up
create table participant_device_hints (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid primary key,
    generation bigint not null check (generation > 0),
    device_type text check (device_type in ('phone', 'tablet', 'computer')),
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id) on delete cascade
);

-- +goose Down
drop table participant_device_hints;
