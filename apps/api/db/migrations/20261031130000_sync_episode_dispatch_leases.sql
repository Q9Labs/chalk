-- +goose Up
set lock_timeout = '750ms';

create sequence if not exists sync_episode_dispatch_fence_seq as bigint;

-- Bind the sequence at creation, with a fixed search path at execution. Runtime
-- writers need only their existing table grants.
-- +goose StatementBegin
create or replace function next_sync_episode_dispatch_fence() returns bigint
    language sql volatile security definer set search_path = pg_catalog
    return nextval('sync_episode_dispatch_fence_seq'::regclass);
-- +goose StatementEnd

create table sync_episode_dispatch_leases (
    tenant_id uuid not null,
    episode_id uuid not null,
    owner_id uuid not null,
    fence bigint not null,
    expires_at timestamptz not null,
    primary key (tenant_id, episode_id)
);

reset lock_timeout;

-- +goose Down
set lock_timeout = '750ms';
drop table if exists sync_episode_dispatch_leases;
drop function if exists next_sync_episode_dispatch_fence();
drop sequence if exists sync_episode_dispatch_fence_seq;
reset lock_timeout;
