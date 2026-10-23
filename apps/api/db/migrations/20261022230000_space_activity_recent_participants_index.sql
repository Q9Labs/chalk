-- +goose NO TRANSACTION
-- +goose Up
-- Serves listSpaceActivity's five most recent joins in an Episode without sorting every seat.
-- The running release keeps writing participant seats while this applies, so the index is dropped
-- and built concurrently and never holds a lock that blocks those writes. Each statement commits on
-- its own, and Goose records the migration only after both succeed, so a run that stops early is
-- run again. Every run first drops whatever index an earlier run of this migration left behind,
-- finished or not, and then builds it again, so the end state is always one valid index.
-- The marker below covers that recovery inside this same migration; no earlier release used the index.
-- chalk:removed-in #423
drop index concurrently if exists participants_episode_recent_join_idx;

create index concurrently participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

-- +goose Down
drop index concurrently if exists participants_episode_recent_join_idx;
