-- +goose Up
-- Serves listSpaceActivity's five most recent joins in an Episode without sorting every seat.
create index participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

-- +goose Down
drop index participants_episode_recent_join_idx;
