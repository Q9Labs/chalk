-- +goose NO TRANSACTION
-- +goose Up
-- Serves listSpaceActivity's five most recent joins in an Episode without sorting every seat.
-- The running release keeps writing participant seats while this applies, so the index builds
-- concurrently and never holds a lock that blocks those writes. Each statement commits on its own.
-- An interrupted concurrent build leaves an invalid index that "if not exists" would skip, so a
-- rerun first renames that leftover aside (a rename does not block writes), drops it concurrently,
-- and builds the index again.

-- +goose StatementBegin
do $$
begin
    if exists (
        select 1
        from pg_index
        where indexrelid = to_regclass('participants_episode_recent_join_idx')
            and not indisvalid
    ) then
        alter index participants_episode_recent_join_idx rename to participants_episode_recent_join_idx_invalid;
    end if;
end
$$;
-- +goose StatementEnd

drop index concurrently if exists participants_episode_recent_join_idx_invalid;

create index concurrently if not exists participants_episode_recent_join_idx
    on participants(tenant_id, space_id, episode_id, (coalesce(first_joined_at, joined_at)) desc, id)
    where coalesce(first_joined_at, joined_at) is not null;

-- +goose StatementBegin
do $$
begin
    if exists (
        select 1
        from pg_index
        where indexrelid = to_regclass('participants_episode_recent_join_idx')
            and not indisvalid
    ) then
        raise exception 'participants_episode_recent_join_idx is invalid after its concurrent build; rerun this migration to rebuild it';
    end if;
end
$$;
-- +goose StatementEnd

-- +goose Down
drop index concurrently if exists participants_episode_recent_join_idx;
