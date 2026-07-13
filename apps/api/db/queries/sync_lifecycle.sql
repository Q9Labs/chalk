-- name: ReserveSessionCreateRequest :one
insert into session_create_requests (
    tenant_id,
    room_id,
    request_key,
    request_fingerprint,
    session_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(session_id)
)
on conflict (tenant_id, room_id, request_key) do nothing
returning *;

-- name: GetSessionCreateRequest :one
select *
from session_create_requests
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and request_key = sqlc.arg(request_key);

-- name: CreateLifecycleRoomSession :one
insert into room_sessions (
    id,
    status,
    metadata,
    room_id,
    tenant_id,
    created_by_user_id,
    started_at,
    host_exit_policy,
    role_capabilities,
    maximum_duration_seconds,
    maximum_duration_ceiling_seconds,
    deadline_at
) select
    sqlc.arg(id),
    'active',
    sqlc.narg(metadata),
    rooms.id,
    rooms.tenant_id,
    sqlc.narg(created_by_user_id),
    sqlc.narg(started_at),
    sqlc.arg(host_exit_policy),
    sqlc.arg(role_capabilities),
    sqlc.arg(maximum_duration_seconds),
    sqlc.arg(maximum_duration_ceiling_seconds),
    sqlc.arg(deadline_at)
from rooms
where
    rooms.tenant_id = sqlc.arg(tenant_id)
    and rooms.id = sqlc.arg(room_id)
returning *;

-- name: CreateSyncSessionControl :one
insert into sync_session_control (
    tenant_id,
    room_id,
    session_id,
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
    sqlc.arg(room_id),
    sqlc.arg(session_id),
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

-- name: LockSyncSessionControlForUpdate :one
select *
from sync_session_control
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
for update;

-- name: LockLifecycleRoomSessionForUpdate :one
select *
from room_sessions
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(session_id)
for update;

-- name: LockLifecycleIntentForRequestForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and intent_name = sqlc.arg(intent_name)
    and request_key = sqlc.arg(request_key)
for update;

-- name: LockLifecycleIntentForParticipantTransitionForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and intent_name = sqlc.arg(intent_name)
    and participant_session_id = sqlc.arg(participant_session_id)
    and participant_session_generation = sqlc.arg(participant_session_generation)
for update;

-- name: LockSessionEndLifecycleIntentForUpdate :one
select *
from sync_lifecycle_intents
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and intent_name = 'session_ended'
for update;

-- name: LockLifecycleParticipantForUpdate :one
select *
from participants
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and id = sqlc.arg(participant_session_id)
for update;

-- name: GetSyncTokenSubject :one
select
    participants.tenant_id,
    participants.room_id,
    participants.session_id,
    participants.id as participant_session_id,
    participants.generation,
    participants.name,
    participants.role as initial_role,
    participants.eligible_roles,
    sync_lifecycle_intents.lifecycle_intent_id as admission_lifecycle_intent_id
from participants
join room_sessions on
    room_sessions.tenant_id = participants.tenant_id
    and room_sessions.room_id = participants.room_id
    and room_sessions.id = participants.session_id
join sync_lifecycle_intents on
    sync_lifecycle_intents.tenant_id = participants.tenant_id
    and sync_lifecycle_intents.room_id = participants.room_id
    and sync_lifecycle_intents.session_id = participants.session_id
    and sync_lifecycle_intents.participant_session_id = participants.id
    and sync_lifecycle_intents.participant_session_generation = participants.generation
    and sync_lifecycle_intents.intent_name = 'participant_joined'
left join sync_admission_requests on
    sync_admission_requests.tenant_id = participants.tenant_id
    and sync_admission_requests.room_id = participants.room_id
    and sync_admission_requests.session_id = participants.session_id
    and sync_admission_requests.participant_session_id = participants.id
where
    participants.tenant_id = sqlc.arg(tenant_id)
    and participants.room_id = sqlc.arg(room_id)
    and participants.session_id = sqlc.arg(session_id)
    and participants.id = sqlc.arg(participant_session_id)
    and participants.status = 'active'
    and room_sessions.status = 'active'
    and sync_lifecycle_intents.status = 'applied'
    and sync_lifecycle_intents.applied_event_id is not null
    and (
        sync_admission_requests.admission_request_id is null
        or sync_admission_requests.status = 'admitted'
    )
order by sync_lifecycle_intents.created_at desc
limit 1;

-- name: ReserveParticipantAdmission :one
update sync_session_control
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
    sync_session_control.tenant_id = sqlc.arg(tenant_id)
    and sync_session_control.room_id = sqlc.arg(room_id)
    and sync_session_control.session_id = sqlc.arg(session_id)
    and sync_session_control.snapshot_bytes + sync_session_control.snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes) <= 1048576
    and sync_session_control.lifecycle_event_count + sync_session_control.lifecycle_reserved_events + 2 <= 2048
    and sync_session_control.lifecycle_event_bytes + sync_session_control.lifecycle_reserved_bytes + 2 * sqlc.arg(reservation_bytes)::bigint <= 33554432
    and sync_session_control.lifecycle_intent_count + sync_session_control.lifecycle_reserved_intents + 2 <= 2048
    and sync_session_control.lifecycle_intent_bytes + sync_session_control.lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) + sqlc.arg(reservation_bytes)::bigint <= 33554432
    and (
        select count(*)
        from participants
        where
            participants.tenant_id = sync_session_control.tenant_id
            and participants.room_id = sync_session_control.room_id
            and participants.session_id = sync_session_control.session_id
            and participants.status in ('joining', 'active', 'leaving')
    ) < sqlc.arg(max_active_participants)::bigint
returning *;

-- name: ReserveApprovalAdmission :one
update sync_session_control
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
    sync_session_control.tenant_id = sqlc.arg(tenant_id)
    and sync_session_control.room_id = sqlc.arg(room_id)
    and sync_session_control.session_id = sqlc.arg(session_id)
    and sync_session_control.snapshot_bytes + sync_session_control.snapshot_reserved_bytes + sqlc.arg(snapshot_reservation_bytes) <= 1048576
    and sync_session_control.lifecycle_event_count + sync_session_control.lifecycle_reserved_events + 3 <= 2048
    and sync_session_control.lifecycle_event_bytes + sync_session_control.lifecycle_reserved_bytes + 3 * sqlc.arg(reservation_bytes)::bigint <= 33554432
    and sync_session_control.lifecycle_intent_count + sync_session_control.lifecycle_reserved_intents + 3 <= 2048
    and sync_session_control.lifecycle_intent_bytes + sync_session_control.lifecycle_reserved_intent_bytes + sqlc.arg(requested_payload_bytes) + sqlc.arg(join_payload_bytes) + sqlc.arg(reservation_bytes)::bigint <= 33554432
    and (
        select count(*)
        from participants
        where
            participants.tenant_id = sync_session_control.tenant_id
            and participants.room_id = sync_session_control.room_id
            and participants.session_id = sync_session_control.session_id
            and participants.status in ('joining', 'active', 'leaving')
    ) < sqlc.arg(max_active_participants)::bigint
returning *;

-- name: CreateAdmissionRequest :one
insert into sync_admission_requests (
    tenant_id,
    room_id,
    session_id,
    admission_request_id,
    request_key,
    request_fingerprint,
    participant_session_id,
    display_name,
    initial_role,
    eligible_roles,
    expires_at
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.arg(admission_request_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(participant_session_id),
    sqlc.arg(display_name),
    sqlc.arg(initial_role),
    sqlc.arg(eligible_roles),
    sqlc.arg(expires_at)
)
returning *;

-- name: LockAdmissionRequestForParticipant :one
select *
from sync_admission_requests
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and participant_session_id = sqlc.arg(participant_session_id)
for update;

-- name: LockTenantExternalOperationForRequest :one
select *
from sync_external_operations
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and operation_name = sqlc.arg(operation_name)
    and request_key = sqlc.arg(request_key)
for update;

-- name: CreateTenantExternalOperation :one
insert into sync_external_operations (
    tenant_id,
    room_id,
    session_id,
    external_operation_id,
    request_key,
    request_fingerprint,
    operation_name,
    target_participant_session_id,
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
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.arg(external_operation_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(operation_name),
    sqlc.narg(target_participant_session_id),
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
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
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
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and status in ('starting', 'recording', 'stopping')
for update;

-- name: LockActiveParticipantsForTenantEnd :many
select participants.id, participants.generation
from participants
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and status in ('active', 'leaving')
order by participants.id
for update;

-- name: CreateTenantEndPublicationFence :one
insert into sync_publication_fences (
    tenant_id,
    room_id,
    session_id,
    participant_session_id,
    participant_generation,
    source,
    external_operation_id,
    expires_at
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.arg(participant_session_id),
    sqlc.arg(participant_generation),
    sqlc.arg(source),
    sqlc.arg(external_operation_id),
    now() + interval '5 minutes'
)
on conflict (tenant_id, session_id, participant_session_id, source) do update
set
    room_id = excluded.room_id,
    participant_generation = excluded.participant_generation,
    external_operation_id = excluded.external_operation_id,
    expires_at = excluded.expires_at,
    created_at = now()
where sync_publication_fences.expires_at <= now()
returning external_operation_id;

-- name: MarkTenantExternalSessionEnding :one
update room_sessions
set status = 'ending', updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(session_id)
    and status = 'active'
returning *;

-- name: FailPendingTenantControlOperationsForEnd :execrows
update sync_external_operations
set
    status = 'failed',
    fence_active = false,
    last_error_code = 'session_ended',
    completed_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and operation_name in ('tenant_transfer_host', 'tenant_set_deadline')
    and status = 'pending';

-- name: LockHostRecoveryTarget :one
select participants.*
from participants
join room_sessions on
    room_sessions.tenant_id = participants.tenant_id
    and room_sessions.room_id = participants.room_id
    and room_sessions.id = participants.session_id
where
    participants.tenant_id = sqlc.arg(tenant_id)
    and participants.room_id = sqlc.arg(room_id)
    and participants.session_id = sqlc.arg(session_id)
    and participants.id = sqlc.arg(participant_session_id)
    and participants.generation = sqlc.arg(participant_generation)
    and participants.status = 'active'
    and 'host' = any(participants.eligible_roles)
    and room_sessions.status = 'active'
for update of participants;

-- name: LockDeadlineSessionForUpdate :one
select *
from room_sessions
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(session_id)
for update;

-- name: ClaimDueSessionDeadlines :many
select
    sessions.tenant_id,
    sessions.room_id,
    sessions.id as session_id,
    sessions.deadline_at,
    sessions.deadline_generation
from room_sessions sessions
where
    sessions.status = 'active'
    and sessions.deadline_at <= now()
    and not exists (
        select 1
        from sync_external_operations operations
        where
            operations.tenant_id = sessions.tenant_id
            and operations.room_id = sessions.room_id
            and operations.session_id = sessions.id
            and operations.operation_name = 'maximum_duration_expired'
            and operations.deadline_generation = sessions.deadline_generation
    )
order by sessions.deadline_at, sessions.id
for update of sessions skip locked
limit sqlc.arg(batch_size);

-- name: ReserveParticipantRemoval :one
update sync_session_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and lifecycle_reserved_intents >= 1
    and lifecycle_reserved_intent_bytes >= sqlc.arg(reservation_bytes)
    and lifecycle_intent_count + lifecycle_reserved_intents <= 2048
    and lifecycle_intent_bytes + lifecycle_reserved_intent_bytes + sqlc.arg(intent_payload_bytes) - sqlc.arg(reservation_bytes) <= 33554432
returning *;

-- name: ReserveSessionEnd :one
update sync_session_control
set
    lifecycle_intent_count = lifecycle_intent_count + 1,
    lifecycle_intent_bytes = lifecycle_intent_bytes + sqlc.arg(intent_payload_bytes),
    lifecycle_reserved_intents = lifecycle_reserved_intents - 1,
    lifecycle_reserved_intent_bytes = lifecycle_reserved_intent_bytes - sqlc.arg(reservation_bytes),
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
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
    eligible_roles,
    tenant_id,
    room_id,
    session_id,
    user_id,
    generation,
    status
) values (
    sqlc.arg(id),
    sqlc.narg(name),
    sqlc.narg(metadata),
    array[]::text[],
    sqlc.arg(initial_role),
    sqlc.arg(eligible_roles),
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.narg(user_id),
    1,
    'joining'
)
returning *;

-- name: CreateLifecycleIntent :one
insert into sync_lifecycle_intents (
    tenant_id,
    room_id,
    session_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_session_id,
    participant_session_generation,
    payload,
    status,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.narg(participant_session_id),
    sqlc.narg(participant_session_generation),
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
    room_id,
    session_id,
    lifecycle_intent_id,
    request_key,
    request_fingerprint,
    intent_name,
    participant_session_id,
    participant_session_generation,
    payload,
    status,
    next_attempt_at,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id
) values (
    sqlc.arg(tenant_id),
    sqlc.arg(room_id),
    sqlc.arg(session_id),
    sqlc.arg(lifecycle_intent_id),
    sqlc.arg(request_key),
    sqlc.arg(request_fingerprint),
    sqlc.arg(intent_name),
    sqlc.arg(participant_session_id),
    sqlc.arg(participant_session_generation),
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
    and room_id = sqlc.arg(room_id)
    and session_id = sqlc.arg(session_id)
    and id = sqlc.arg(participant_session_id)
    and generation = sqlc.arg(participant_session_generation)
    and status = 'active'
returning *;

-- name: MarkLifecycleSessionEnding :one
update room_sessions
set
    status = 'ending',
    updated_at = now()
where
    tenant_id = sqlc.arg(tenant_id)
    and room_id = sqlc.arg(room_id)
    and id = sqlc.arg(session_id)
    and status = 'active'
returning *;
