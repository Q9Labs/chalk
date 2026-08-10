-- Dashboard account-bound Space join primitives. These queries are kept
-- separate from the legacy Episode/Participant broker surface so slug lookup,
-- live-Episode reuse, and account ownership stay explicit.

-- name: LockTenantSpaceBySlugForUpdate :one
select *
from spaces
where tenant_id = sqlc.arg(tenant_id)
  and slug = sqlc.arg(slug)
for update;

-- name: LockLiveEpisodeForUpdate :one
select *
from episodes
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and status in ('active', 'ending')
order by created_at desc, id desc
limit 1
for update;

-- name: LockLatestEpisodeForUpdate :one
select *
from episodes
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
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
for update;

-- name: LockLatestDashboardParticipantForUpdate :one
select participants.*
from participants
join episodes on episodes.tenant_id = participants.tenant_id
  and episodes.space_id = participants.space_id
  and episodes.id = participants.episode_id
where participants.tenant_id = sqlc.arg(tenant_id)
  and participants.space_id = sqlc.arg(space_id)
  and participants.account_id = sqlc.arg(account_id)
order by episodes.created_at desc, participants.created_at desc
limit 1
for update of participants;

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
    1, 'joining'
)
returning *;
