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
    fence_active,
    control_revision
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
    sqlc.arg(fence_active),
    nextval('sync_source_control_revisions')
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
    and episodes.id <> all(sqlc.arg(excluded_episode_ids)::uuid[])
order by episodes.deadline_at, episodes.id
for update of control skip locked
limit sqlc.arg(batch_size);
