-- +goose Up
alter table recording_pool_health
    add column demand_revision text not null default 'legacy'
    check (octet_length(demand_revision) between 1 and 128);

create table recording_fleet_nodes (
    environment text not null check (environment ~ '^[a-z][a-z0-9-]{0,31}$'),
    role text not null check (role in ('capture', 'render')),
    provider_id text not null check (octet_length(provider_id) between 1 and 128),
    node_name text not null check (octet_length(node_name) between 1 and 255),
    region text not null check (region ~ '^[a-z][a-z0-9-]{0,31}$'),
    release_id text not null check (octet_length(release_id) between 1 and 128),
    image_digest text not null check (image_digest ~ '^sha256:[0-9a-f]{64}$'),
    boot_generation bigint not null check (boot_generation > 0),
    inventory_digest text not null check (inventory_digest ~ '^[0-9a-f]{64}$'),
    worker_id uuid,
    state text not null check (state in ('requested', 'active', 'draining', 'revoked')),
    ready boolean not null default false,
    admission_open boolean not null default false,
    ready_capacity integer not null default 0 check (ready_capacity >= 0),
    observed_at timestamptz,
    revoked_at timestamptz,
    updated_at timestamptz not null default now(),
    created_at timestamptz not null default now(),
    primary key (environment, role, provider_id),
    unique (worker_id),
    check ((state = 'requested') = (worker_id is null)),
    check (not admission_open or (state = 'active' and ready and ready_capacity > 0)),
    check ((state = 'revoked') = (revoked_at is not null)),
    check (state <> 'revoked' or (not ready and not admission_open and ready_capacity = 0))
);

create index recording_fleet_nodes_role_state_idx
    on recording_fleet_nodes(environment, role, state, provider_id);

-- +goose Down
drop table recording_fleet_nodes;
alter table recording_pool_health drop column demand_revision;
