-- name: ReserveEpisodeCreateRequest :one
insert into episode_create_requests (
    tenant_id,
    space_id,
    request_key,
    request_fingerprint,
    episode_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(episode_id)
)
on conflict (tenant_id, space_id, request_key) do nothing
returning *;

-- name: GetEpisodeCreateRequest :one
select *
from episode_create_requests
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and request_key = sqlc.arg(request_key);

-- name: CreateLifecycleEpisode :one
insert into episodes (
    id,
    status,
    metadata,
    space_id,
    tenant_id,
    created_by_user_id,
    started_at,
    deadline_at,
    config_snapshot
) select
    sqlc.arg(id),
    'active',
    sqlc.narg(metadata),
    spaces.id,
    spaces.tenant_id,
    sqlc.narg(created_by_user_id),
    coalesce(sqlc.narg(started_at)::timestamptz, now()),
    sqlc.arg(deadline_at),
    jsonb_build_object(
        'roles', coalesce((
            select jsonb_object_agg(role.name, to_jsonb(role.capabilities))
            from space_roles role
            where role.tenant_id = spaces.tenant_id and role.space_id = spaces.id
        ), '{}'::jsonb),
        'admission_policy', spaces.admission_policy,
        'default_episode_duration_seconds', spaces.default_episode_duration_seconds,
        'maximum_episode_duration_seconds', spaces.maximum_episode_duration_seconds,
        'linger_window_seconds', spaces.linger_window_seconds,
        'artifact_policy', sqlc.arg(artifact_policy)::jsonb,
        'media_plane_binding', sqlc.arg(media_plane_binding)::jsonb
    )
from spaces
where
    spaces.tenant_id = sqlc.arg(tenant_id)
    and spaces.id = sqlc.arg(space_id)
    and spaces.archived_at is null
for update
returning *;

-- name: LockTenantSpaceForUpdate :one
select *
from spaces
where
    tenant_id = sqlc.arg(tenant_id)
    and id = sqlc.arg(id)
for update;

-- name: CreateSyncEpisodeControl :one
insert into sync_episode_control (
    tenant_id,
    space_id,
    episode_id,
    control_revision,
    folded_state,
    state_schema_version,
    state_digest,
    snapshot_bytes,
    snapshot_reserved_bytes,
    participant_event_count,
    participant_event_bytes,
    lifecycle_event_count,
    lifecycle_event_bytes,
    lifecycle_reserved_events,
    lifecycle_reserved_bytes,
    lifecycle_intent_count,
    lifecycle_intent_bytes,
    lifecycle_reserved_intents,
    lifecycle_reserved_intent_bytes,
    receipt_count,
    receipt_bytes
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    0,
    sqlc.arg(folded_state),
    sqlc.arg(state_schema_version),
    sqlc.arg(state_digest),
    sqlc.arg(snapshot_bytes),
    0,
    0,
    0,
    0,
    0,
    1,
    16384,
    0,
    0,
    1,
    16384,
    0,
    0
)
returning *;

-- name: LockSyncEpisodeControlForUpdate :one
select *
from sync_episode_control
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
for update;

-- name: LockLifecycleEpisodeForUpdate :one
select *
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(episode_id)
for update;

-- name: LockLifecycleIntentForRequestForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and intent_name = sqlc.arg(intent_name)
    and request_key = sqlc.arg(request_key)
for update;

-- name: LockLifecycleIntentForParticipantTransitionForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and intent_name = sqlc.arg(intent_name)
    and participant_id = sqlc.arg(participant_id)
    and participant_generation = sqlc.arg(participant_generation)
for update;

-- name: LockEpisodeEndLifecycleIntentForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and intent_name = 'episode_ended'
for update;

-- name: LockLifecycleParticipantForUpdate :one
select *
from participants
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and id = sqlc.arg(participant_id)
for update;

-- name: GetSyncTokenSubject :one
select
    participants.tenant_id,
    participants.space_id,
    participants.episode_id,
    episodes.started_at,
    participants.id as participant_id,
    participants.generation,
    participants.name,
    participants.role,
    participants.capabilities,
    sync_lifecycle_intents.lifecycle_intent_id as admission_lifecycle_intent_id
from participants
join episodes on
    episodes.tenant_id = participants.tenant_id
    and episodes.space_id = participants.space_id
    and episodes.id = participants.episode_id
join sync_lifecycle_intents on
    sync_lifecycle_intents.tenant_id = participants.tenant_id
    and sync_lifecycle_intents.space_id = participants.space_id
    and sync_lifecycle_intents.episode_id = participants.episode_id
    and sync_lifecycle_intents.participant_id = participants.id
    and sync_lifecycle_intents.participant_generation = participants.generation
    and sync_lifecycle_intents.intent_name = 'participant_joined'
left join sync_admission_requests on
    sync_admission_requests.tenant_id = participants.tenant_id
    and sync_admission_requests.space_id = participants.space_id
    and sync_admission_requests.episode_id = participants.episode_id
    and sync_admission_requests.participant_id = participants.id
where
    participants.tenant_id = sqlc.arg(tenant_id)
    and participants.space_id = sqlc.arg(space_id)
    and participants.episode_id = sqlc.arg(episode_id)
    and participants.id = sqlc.arg(participant_id)
    and episodes.status = 'active'
    and (
        (participants.status = 'active' and sync_lifecycle_intents.status = 'applied'
            and sync_lifecycle_intents.applied_event_id is not null)
        or (participants.status = 'joining' and sync_lifecycle_intents.status = 'pending'
            and exists (select 1 from participant_join_seats seat
                where seat.participant_id = participants.id and seat.generation = participants.generation
                  and seat.state = 'pending' and seat.expires_at > now()))
    )
    and (
        sync_admission_requests.admission_request_id is null
        or sync_admission_requests.status = 'admitted'
    )
order by sync_lifecycle_intents.created_at desc
limit 1;
