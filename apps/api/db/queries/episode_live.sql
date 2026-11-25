-- name: GetLiveEpisodeForPublicJoin :one
select * from episodes
where tenant_id = sqlc.arg(tenant_id) and space_id = sqlc.arg(space_id)
  and status in ('active', 'ending')
order by created_at desc, id desc limit 1;

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

-- name: ResolveAdmissionIdentity :one
insert into identities (id, tenant_id, kind, external_id, display_name)
values (sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(kind), sqlc.arg(external_id), sqlc.arg(display_name))
on conflict (tenant_id, external_id) do update set external_id = excluded.external_id
returning id, kind;

-- name: ListSpaceLobbyParticipants :many
select participants.id,
       coalesce(participants.name, '') as display_name,
       (case
         when identities.id is not null then identities.kind
         when participants.account_id is not null or participants.role = 'owner' then 'user'
         else 'guest'
       end)::text as identity_kind,
       participants.notice
from episodes
join participants
  on participants.tenant_id = episodes.tenant_id
 and participants.space_id = episodes.space_id
 and participants.episode_id = episodes.id
left join identities
  on identities.tenant_id = participants.tenant_id
 and identities.id = participants.identity_id
where episodes.tenant_id = sqlc.arg(tenant_id)
  and episodes.space_id = sqlc.arg(space_id)
  and episodes.status in ('active', 'ending')
  and participants.status in ('joining', 'active')
order by participants.created_at, participants.id;
