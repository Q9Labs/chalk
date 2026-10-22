-- +goose NO TRANSACTION
-- +goose Up
-- Serves listSpaceActivity's five most recent joins in an Episode without sorting every seat.
-- The running release keeps writing participant seats while this applies, so the index builds
-- concurrently and never holds a lock that blocks those writes. Each statement commits on its own.
-- An interrupted concurrent build leaves an invalid index that "if not exists" would skip, and the
-- additive-migration rule keeps DROP out of Up, so a concurrent reindex follows the build: on a
-- rerun it turns that leftover into a valid index, and on a first run it rebuilds the new index once.
create index concurrently if not exists participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

reindex index concurrently participants_episode_recent_join_idx;

-- +goose Down
drop index concurrently if exists participants_episode_recent_join_idx;
