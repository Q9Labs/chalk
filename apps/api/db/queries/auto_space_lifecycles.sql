-- name: ListDueAutoSpaceLifecycles :many
with reclaim_expired_claims as (
    update auto_space_lifecycles
    set state = 'active', claim_expires_at = null, updated_at = now()
    where state = 'archiving'
      and claim_expires_at <= sqlc.arg(now_at)
    returning tenant_id, space_id
)
select lifecycle.tenant_id, lifecycle.space_id, lifecycle.deadline_at,
       lifecycle.creator_arrival_handle, lifecycle.state, lifecycle.claim_expires_at,
       lifecycle.next_retry_at,
       lifecycle.retry_count, lifecycle.last_error_family, lifecycle.archive_completed_at,
       lifecycle.journey_id, lifecycle.created_at, lifecycle.updated_at
from auto_space_lifecycles lifecycle
left join reclaim_expired_claims reclaimed
  on reclaimed.tenant_id = lifecycle.tenant_id
 and reclaimed.space_id = lifecycle.space_id
left join space_public_arrivals creator_arrival
  on creator_arrival.tenant_id = lifecycle.tenant_id
 and creator_arrival.space_id = lifecycle.space_id
 and creator_arrival.arrival_handle = lifecycle.creator_arrival_handle
where (lifecycle.state = 'active' or reclaimed.tenant_id is not null)
  and (lifecycle.deadline_at <= sqlc.arg(now_at)
       or (
           creator_arrival.state in ('left', 'rejected', 'unavailable')
           and not exists (
               select 1
               from participants active_participant
               where active_participant.tenant_id = lifecycle.tenant_id
                 and active_participant.space_id = lifecycle.space_id
                 and active_participant.episode_id = creator_arrival.episode_id
                 and active_participant.status in ('joining', 'active', 'leaving')
           )
           -- The creator's departure waits the Episode's linger window after the
           -- last departure, so a quick Rejoin continues the same call.
           and greatest(
               creator_arrival.terminal_at,
               (
                   select max(p.left_at)
                   from participants p
                   where p.tenant_id = creator_arrival.tenant_id
                     and p.space_id = creator_arrival.space_id
                     and p.episode_id = creator_arrival.episode_id
                     and p.joined_at is not null
               )
           ) + make_interval(secs => coalesce((
               select (e.config_snapshot->>'linger_window_seconds')::integer
               from episodes e
               where e.tenant_id = creator_arrival.tenant_id
                 and e.space_id = creator_arrival.space_id
                 and e.id = creator_arrival.episode_id
           ), 0)) <= sqlc.arg(now_at)
       ))
  and (lifecycle.next_retry_at is null or lifecycle.next_retry_at <= sqlc.arg(now_at))
order by lifecycle.deadline_at, lifecycle.tenant_id, lifecycle.space_id
limit sqlc.arg(page_size)::integer;

-- name: GetAutoSpaceLifecycle :one
select tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at
from auto_space_lifecycles
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id);

-- name: LockAutoSpaceLifecycle :one
select tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at
from auto_space_lifecycles
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
for update;

-- name: CreateAutoSpaceLifecycle :one
insert into auto_space_lifecycles (
    tenant_id, space_id, deadline_at, creator_arrival_handle, state,
    next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id
)
values (
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(deadline_at),
    sqlc.narg(creator_arrival_handle), sqlc.arg(state), sqlc.narg(next_retry_at),
    sqlc.arg(retry_count), sqlc.narg(last_error_family), sqlc.narg(archive_completed_at), sqlc.narg(journey_id)
)
on conflict (tenant_id, space_id) do nothing
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
       claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
       created_at, updated_at;

-- name: MarkAutoSpaceLifecycleArchiving :one
update auto_space_lifecycles
set state = 'archiving', claim_expires_at = now() + interval '5 minutes', updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and state = 'active'
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;

-- name: MarkAutoSpaceLifecycleArchived :one
update auto_space_lifecycles
set state = 'archived', claim_expires_at = null, archive_completed_at = now(), next_retry_at = null,
    last_error_family = null, updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;

-- name: RetryAutoSpaceLifecycle :one
update auto_space_lifecycles
set state = 'active', claim_expires_at = null, next_retry_at = sqlc.arg(next_retry_at),
    retry_count = retry_count + 1, last_error_family = sqlc.narg(last_error_family),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and state = 'archiving'
returning tenant_id, space_id, deadline_at, creator_arrival_handle, state,
          claim_expires_at, next_retry_at, retry_count, last_error_family, archive_completed_at, journey_id,
          created_at, updated_at;
