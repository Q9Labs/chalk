-- +goose NO TRANSACTION
-- +goose Up
-- Serves listSpaceActivity's five most recent joins in an Episode without sorting every seat.
-- The running release keeps writing participant seats while this applies, so the index is dropped
-- and built concurrently and never holds a lock that blocks those writes. Each statement commits on
-- its own, and Goose records the migration only after both succeed. An interrupted build leaves an
-- invalid index, so every run first drops whatever this migration left and then builds it once.
-- The drop only removes an unfinished build of this same migration, which no release reads.
-- chalk:removed-in #423
drop index concurrently if exists participants_episode_recent_join_idx;

create index concurrently participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

-- +goose Down
drop index concurrently if exists participants_episode_recent_join_idx;
