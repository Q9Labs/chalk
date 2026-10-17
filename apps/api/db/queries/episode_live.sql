-- name: LockLiveEpisodeForUpdate :one
select *
from episodes
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and status in ('active', 'ending')
order by created_at desc, id desc
limit 1
for update;


-- name: LockDashboardParticipantForUpdate :one
select *
from participants
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and account_id = sqlc.arg(account_id)
  and status in ('joining', 'active')
for update;


-- name: LockDashboardJoinIntentForUpdate :one
select *
from sync_lifecycle_intents
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and participant_id = sqlc.arg(participant_id)
  and intent_name = 'participant_joined'
order by created_at desc
limit 1
for update;


-- name: CreateDashboardLifecycleParticipant :one
insert into participants (
    id, name, metadata, capabilities, role,
    tenant_id, space_id, episode_id, account_id, identity_id,
    generation, status
) values (
    sqlc.arg(id), sqlc.arg(name), sqlc.narg(metadata), sqlc.arg(capabilities), sqlc.arg(role),
    sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(account_id), null,
    (select coalesce(max(generation), 0) + 1 from participants
     where tenant_id = sqlc.arg(tenant_id)
       and episode_id = sqlc.arg(episode_id)
       and account_id = sqlc.arg(account_id)), 'joining'
)
returning *;

