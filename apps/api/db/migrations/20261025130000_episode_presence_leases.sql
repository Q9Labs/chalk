-- +goose Up
create table episode_presence_leases (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    expires_at timestamptz not null,
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id) on delete cascade
);

create table sync_presence_runtime (
    singleton boolean primary key default true check (singleton),
    recover_after timestamptz not null
);
insert into sync_presence_runtime(singleton, recover_after)
values (true, clock_timestamp() + interval '120 seconds');

-- +goose Down
drop table sync_presence_runtime;
drop table episode_presence_leases;
