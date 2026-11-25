-- name: LockScheduledEpisodeSpace :one
-- The Space a booking belongs to, locked against archive and restore until the transaction ends.
select archived_at from spaces
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(space_id)
for share;

-- name: PutScheduledEpisode :one
-- Replaces the expectation of a booking that is not cancelled. A cancelled booking is left alone and
-- no row comes back. A replay that changes nothing keeps updated_at.
insert into scheduled_episodes (tenant_id, space_id, id, starts_at, expected_ends_at, expected_participants, metadata)
values (
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(id),
    sqlc.arg(starts_at), sqlc.arg(expected_ends_at), sqlc.arg(expected_participants), sqlc.narg(metadata)
)
on conflict (tenant_id, space_id, id) do update set
    starts_at = excluded.starts_at,
    expected_ends_at = excluded.expected_ends_at,
    expected_participants = excluded.expected_participants,
    metadata = excluded.metadata,
    updated_at = case
        when (scheduled_episodes.starts_at, scheduled_episodes.expected_ends_at, scheduled_episodes.expected_participants, scheduled_episodes.metadata)
            is not distinct from (excluded.starts_at, excluded.expected_ends_at, excluded.expected_participants, excluded.metadata)
        then scheduled_episodes.updated_at
        else now()
    end
where scheduled_episodes.cancelled_at is null
returning tenant_id, space_id, id, starts_at, expected_ends_at, expected_participants, metadata, cancelled_at, created_at, updated_at;

-- name: GetScheduledEpisode :one
select tenant_id, space_id, id, starts_at, expected_ends_at, expected_participants, metadata, cancelled_at, created_at, updated_at
from scheduled_episodes
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id) and id = sqlc.arg(id);

-- name: CancelScheduledEpisode :exec
-- Cancels a booking, or records a tombstone for an id that was never written. Cancelling again keeps
-- the first cancelled_at.
insert into scheduled_episodes (tenant_id, space_id, id, cancelled_at)
values (sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(id), now())
on conflict (tenant_id, space_id, id) do update set
    cancelled_at = now(),
    updated_at = now()
where scheduled_episodes.cancelled_at is null;

-- name: ListUpcomingScheduledEpisodes :many
-- The operational lookahead: bookings that are not cancelled and start in [window_start, window_end), earliest first.
select tenant_id, space_id, id, starts_at, expected_ends_at, expected_participants, metadata, cancelled_at, created_at, updated_at
from scheduled_episodes
where cancelled_at is null
  and starts_at >= sqlc.arg(window_start) and starts_at < sqlc.arg(window_end)
order by starts_at, tenant_id, space_id, id
limit sqlc.arg(row_limit);
