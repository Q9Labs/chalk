-- +goose Up
SET LOCAL lock_timeout = '5s';
-- A missing row means everyone, the behaviour every call had before this table.
create table sync_whiteboard_draw_policies (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    updated_by_participant_id uuid not null,
    updated_at timestamptz not null default now(),
    primary key (tenant_id, space_id, episode_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, updated_by_participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

-- Policy changes keep their own receipts, because widening the operation_name
-- check on sync_whiteboard_operation_receipts would mean dropping it.
create table sync_whiteboard_draw_policy_receipts (
    tenant_id uuid not null,
    space_id uuid not null,
    episode_id uuid not null,
    participant_id uuid not null,
    operation_id text not null check (octet_length(operation_id) between 16 and 64),
    policy text not null check (policy in ('everyone', 'hosts', 'picked')),
    completed_at timestamptz not null default now(),
    primary key (tenant_id, space_id, participant_id, operation_id),
    foreign key (tenant_id, space_id, episode_id)
        references episodes(tenant_id, space_id, id)
        on delete cascade,
    foreign key (tenant_id, space_id, episode_id, participant_id)
        references participants(tenant_id, space_id, episode_id, id)
        on delete restrict
);

create index sync_whiteboard_draw_policy_receipts_episode
    on sync_whiteboard_draw_policy_receipts (tenant_id, space_id, episode_id);

-- +goose Down
drop table sync_whiteboard_draw_policy_receipts;
drop table sync_whiteboard_draw_policies;
