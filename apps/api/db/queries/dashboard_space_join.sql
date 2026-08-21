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

-- name: CancelDashboardParticipantJoin :one
with superseded_intent as (
    update sync_lifecycle_intents
    set
        status = 'superseded',
        terminal_reason = 'participant_already_terminal',
        completed_at = now(),
        attempt_count = least(attempt_count::bigint + 1, 2147483647)::integer,
        last_error_code = null
    where
        sync_lifecycle_intents.tenant_id = sqlc.arg(tenant_id)
        and sync_lifecycle_intents.space_id = sqlc.arg(space_id)
        and sync_lifecycle_intents.episode_id = sqlc.arg(episode_id)
        and sync_lifecycle_intents.participant_id = sqlc.arg(participant_id)
        and sync_lifecycle_intents.participant_generation = sqlc.arg(participant_generation)
        and sync_lifecycle_intents.intent_name = 'participant_joined'
        and sync_lifecycle_intents.status = 'pending'
    returning lifecycle_intent_id
), released_control as (
    update sync_episode_control
    set
        snapshot_reserved_bytes = snapshot_reserved_bytes - sqlc.arg(snapshot_reservation_bytes),
        lifecycle_reserved_events = lifecycle_reserved_events - 2,
        lifecycle_reserved_bytes = lifecycle_reserved_bytes - 2 * sqlc.arg(reservation_bytes)::bigint,
        lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
        lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes)::bigint,
        updated_at = now()
    where
        sync_episode_control.tenant_id = sqlc.arg(tenant_id)
        and sync_episode_control.space_id = sqlc.arg(space_id)
        and sync_episode_control.episode_id = sqlc.arg(episode_id)
        and sync_episode_control.snapshot_reserved_bytes >= sqlc.arg(snapshot_reservation_bytes)
        and sync_episode_control.lifecycle_reserved_events >= 2
        and sync_episode_control.lifecycle_reserved_bytes >= 2 * sqlc.arg(reservation_bytes)::bigint
        and sync_episode_control.lifecycle_reserved_intents >= 1
        and sync_episode_control.lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)::bigint
        and exists (select 1 from superseded_intent)
    returning episode_id
)
update participants
set
    status = 'left',
    left_at = coalesce(left_at, now()),
    updated_at = now()
where
    participants.tenant_id = sqlc.arg(tenant_id)
    and participants.space_id = sqlc.arg(space_id)
    and participants.episode_id = sqlc.arg(episode_id)
    and participants.id = sqlc.arg(participant_id)
    and participants.generation = sqlc.arg(participant_generation)
    and participants.status = 'joining'
    and exists (select 1 from released_control)
returning *;
