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
        'linger_window_seconds', spaces.linger_window_seconds
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
    and participants.status = 'active'
    and episodes.status = 'active'
    and sync_lifecycle_intents.status = 'applied'
    and sync_lifecycle_intents.applied_event_id is not null
    and (
        sync_admission_requests.admission_request_id is null
        or sync_admission_requests.status = 'admitted'
    )
order by sync_lifecycle_intents.created_at desc
limit 1;

-- name: ReserveParticipantAdmission :one
update sync_episode_control
set
    snapshot_reserved_bytes = snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes),
    lifecycle_reserved_events = lifecycle_reserved_events + 2,
    lifecycle_reserved_bytes = lifecycle_reserved_bytes + 2 * sqlc.arg(reservation_bytes)::bigint,
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents + 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes + sqlc.arg(reservation_bytes)::bigint,
    updated_at = now()
where
    sync_episode_control.tenant_id = sqlc.arg(tenant_id)
    and sync_episode_control.space_id = sqlc.arg(space_id)
    and sync_episode_control.episode_id = sqlc.arg(episode_id)
    and sync_episode_control.snapshot_bytes + sync_episode_control.snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes) <= 1048576
    and sync_episode_control.lifecycle_event_count + sync_episode_control.lifecycle_reserved_events + 2 <= 2048
    and sync_episode_control.lifecycle_event_bytes + sync_episode_control.lifecycle_reserved_bytes + 2 * sqlc.arg(reservation_bytes)::bigint <= 33554432
    and sync_episode_control.lifecycle_intent_count + sync_episode_control.lifecycle_reserved_intents + 2 <= 2048
    and sync_episode_control.lifecycle_intent_bytes + sync_episode_control.lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) + sqlc.arg(reservation_bytes)::bigint <= 33554432
    and (
        select count(*)
        from participants
        where
            participants.tenant_id = sync_episode_control.tenant_id
            and participants.space_id = sync_episode_control.space_id
            and participants.episode_id = sync_episode_control.episode_id
            and participants.status in ('joining', 'active', 'leaving')
    ) < sqlc.arg(max_active_participants)::bigint
returning *;

-- name: ReserveKnockAdmission :one
update sync_episode_control
set
    snapshot_reserved_bytes = snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes),
    lifecycle_reserved_events = lifecycle_reserved_events + 3,
    lifecycle_reserved_bytes = lifecycle_reserved_bytes + 3 * sqlc.arg(reservation_bytes)::bigint,
    lifecycle_intent_count = lifecycle_intent_count + 2,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(requested_payload_bytes) + sqlc.arg(join_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents + 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes + sqlc.arg(reservation_bytes)::bigint,
    updated_at = now()
where
    sync_episode_control.tenant_id = sqlc.arg(tenant_id)
    and sync_episode_control.space_id = sqlc.arg(space_id)
    and sync_episode_control.episode_id = sqlc.arg(episode_id)
    and sync_episode_control.snapshot_bytes + sync_episode_control.snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes) <= 1048576
    and sync_episode_control.lifecycle_event_count + sync_episode_control.lifecycle_reserved_events + 3 <= 2048
    and sync_episode_control.lifecycle_event_bytes + sync_episode_control.lifecycle_reserved_bytes + 3 * sqlc.arg(reservation_bytes)::bigint <= 33554432
    and sync_episode_control.lifecycle_intent_count + sync_episode_control.lifecycle_reserved_intents + 3 <= 2048
    and sync_episode_control.lifecycle_intent_bytes + sync_episode_control.lifecycle_reserved_intent_bytes + sqlc.arg(requested_payload_bytes) + sqlc.arg(join_payload_bytes) + sqlc.arg(reservation_bytes)::bigint <= 33554432
    and (
        select count(*)
        from participants
        where
            participants.tenant_id = sync_episode_control.tenant_id
            and participants.space_id = sync_episode_control.space_id
            and participants.episode_id = sync_episode_control.episode_id
            and participants.status in ('joining', 'active', 'leaving')
    ) < sqlc.arg(max_active_participants)::bigint
returning *;

-- name: CreateAdmissionRequest :one
insert into sync_admission_requests (
    tenant_id,
    space_id,
    episode_id,
    admission_request_id,
    request_key,
    request_fingerprint,
    participant_id,
    display_name,
    role,
    expires_at
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(admission_request_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(participant_id),
    sqlc.arg(display_name),
    sqlc.arg(role),
    sqlc.arg(expires_at)
)
returning *;

-- name: LockAdmissionRequestForParticipant :one
select *
from sync_admission_requests
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and participant_id = sqlc.arg(participant_id)
for update;

-- name: LockTenantExternalOperationForRequest :one
select *
from sync_external_operations
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and operation_name = sqlc.arg(operation_name)
    and request_key = sqlc.arg(request_key)
for update;

-- name: CreateTenantExternalOperation :one
insert into sync_external_operations (
    tenant_id,
    space_id,
    episode_id,
    external_operation_id,
    request_key,
    request_fingerprint,
    operation_name,
    target_participant_id,
    target_participant_generation,
    recording_id,
    deadline_generation,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id,
    payload,
    fence_active
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(external_operation_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(operation_name),
    sqlc.narg(target_participant_id),
    sqlc.narg(target_participant_generation),
    sqlc.narg(recording_id),
    sqlc.narg(deadline_generation),
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id),
    sqlc.arg(payload),
    sqlc.arg(fence_active)
)
returning *;

-- name: LockPendingDeadlineOperation :one
select *
from sync_external_operations
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and operation_name = 'tenant_set_deadline'
    and status = 'pending'
order by created_at, external_operation_id
limit 1
for update;

-- name: LockActiveRecordingForTenantEnd :one
select recording_id
from sync_recordings
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and status in ('starting', 'recording', 'stopping')
for update;

-- name: LockActiveParticipantsForTenantEnd :many
select participants.id, participants.generation
from participants
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and status in ('active', 'leaving')
order by participants.id
for update;

-- name: CreateTenantEndPublicationFence :one
insert into sync_publication_fences (
    tenant_id,
    space_id,
    episode_id,
    participant_id,
    participant_generation,
    source,
    external_operation_id,
    expires_at
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(participant_id),
    sqlc.arg(participant_generation),
    sqlc.arg(source),
    sqlc.arg(external_operation_id),
    now() + interval '5 minutes'
)
on conflict (tenant_id, episode_id, participant_id, source) do update
set
    space_id = excluded.space_id,
    participant_generation = excluded.participant_generation,
    external_operation_id = excluded.external_operation_id,
    expires_at = excluded.expires_at,
    created_at = now()
where sync_publication_fences.expires_at <= now()
returning external_operation_id;

-- name: MarkTenantExternalEpisodeEnding :one
update episodes
set status = 'ending', updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(episode_id)
    and status = 'active'
returning *;

-- name: FailPendingTenantControlOperationsForEnd :execrows
update sync_external_operations
set
    status = 'failed',
    fence_active = false,
    last_error_code = 'episode_ended',
    completed_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and operation_name in ('tenant_assign_roles', 'tenant_set_deadline')
    and status = 'pending';

-- name: LockDeadlineEpisodeForUpdate :one
select *
from episodes
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(episode_id)
for update;

-- name: ClaimDueEpisodeDeadlines :many
select
    episodes.tenant_id,
    episodes.space_id,
    episodes.id as episode_id,
    episodes.deadline_at,
    episodes.deadline_generation
from episodes episodes
join sync_episode_control control on
    control.tenant_id = episodes.tenant_id
    and control.space_id = episodes.space_id
    and control.episode_id = episodes.id
where
    episodes.status = 'active'
    and episodes.deadline_at <= now()
    and not exists (
        select 1
        from sync_external_operations operations
        where
            operations.tenant_id = episodes.tenant_id
            and operations.space_id = episodes.space_id
            and operations.episode_id = episodes.id
            and operations.operation_name = 'maximum_episode_duration_expired'
            and operations.deadline_generation = episodes.deadline_generation
    )
order by episodes.deadline_at, episodes.id
for update of episodes skip locked
limit sqlc.arg(batch_size);

-- name: ReserveParticipantRemoval :one
update sync_episode_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and lifecycle_reserved_intents >= 1
    and lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)
    and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
    and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) - sqlc.arg(reservation_bytes) <= 33554432
returning *;

-- name: ReserveEpisodeEnd :one
update sync_episode_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and lifecycle_reserved_intents >= 1
    and lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)
    and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
    and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) - sqlc.arg(reservation_bytes) <= 33554432
returning *;

-- name: CreateLifecycleParticipant :one
insert into participants (
    id,
    name,
    metadata,
    capabilities,
    role,
    tenant_id,
    space_id,
    episode_id,
    identity_id,
    generation,
    status
) values (
    sqlc.arg(id),
    sqlc.narg(name),
    sqlc.narg(metadata),
    sqlc.arg(capabilities),
    sqlc.arg(role),
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.narg(identity_id),
    1,
    'joining'
)
returning *;

-- name: CreateLifecycleIntent :one
insert into sync_lifecycle_intents (
    tenant_id,
    space_id,
    episode_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_id,
    participant_generation,
    payload,
    status,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.narg(participant_id),
    sqlc.narg(participant_generation),
    sqlc.arg(payload),
    'pending',
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id)
)
returning *;

-- name: CreateDeferredLifecycleIntent :one
insert into sync_lifecycle_intents (
    tenant_id,
    space_id,
    episode_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_id,
    participant_generation,
    payload,
    status,
    next_attempt_at,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(space_id),
    sqlc.arg(episode_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.arg(participant_id),
    sqlc.arg(participant_generation),
    sqlc.arg(payload),
    'pending',
    'infinity'::timestamptz,
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id)
)
returning *;

-- name: MarkLifecycleParticipantLeaving :one
update participants
set
    status = 'leaving',
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and episode_id = sqlc.arg(episode_id)
    and id = sqlc.arg(participant_id)
    and generation = sqlc.arg(participant_generation)
    and status = 'active'
returning *;

-- name: MarkLifecycleEpisodeEnding :one
update episodes
set
    status = 'ending',
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and space_id = sqlc.arg(space_id)
    and id = sqlc.arg(episode_id)
    and status = 'active'
returning *;
