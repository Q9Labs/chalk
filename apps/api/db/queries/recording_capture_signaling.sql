-- name: GetRecordingCaptureSignalingAuthority :one
select
    authority.envelope_bytes,
    authority.envelope_digest,
    authority.issued_at,
    jobs.lease_expires_at,
    clock_timestamp()::timestamptz as checked_at,
    jobs.id as job_id,
    jobs.tenant_id,
    reservations.space_id,
    jobs.episode_id,
    jobs.recording_id,
    authority.attempt_count,
    authority.fencing_generation,
    authority.capture_epoch
from recording_job_attempt_authorities authority
join recording_jobs jobs on jobs.id = authority.job_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_reservations reservations on reservations.id = pipelines.reservation_id
where authority.job_id = sqlc.arg(job_id)
  and authority.attempt_count = sqlc.arg(attempt_count)
  and authority.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and jobs.kind = 'capture'
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at > clock_timestamp();

-- name: LockRecordingCaptureSignalingAuthority :one
select
    authority.envelope_bytes,
    authority.envelope_digest,
    authority.issued_at,
    jobs.lease_expires_at,
    clock_timestamp()::timestamptz as checked_at,
    jobs.id as job_id,
    jobs.tenant_id,
    reservations.space_id,
    jobs.episode_id,
    jobs.recording_id,
    authority.attempt_count,
    authority.fencing_generation,
    authority.capture_epoch
from recording_job_attempt_authorities authority
join recording_jobs jobs on jobs.id = authority.job_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_reservations reservations on reservations.id = pipelines.reservation_id
where authority.job_id = sqlc.arg(job_id)
  and authority.attempt_count = sqlc.arg(attempt_count)
  and authority.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and jobs.kind = 'capture'
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at > clock_timestamp()
for update of jobs;

-- name: InsertRecordingCaptureConnection :one
insert into recording_capture_connections (
    signaling_handle, capture_epoch, tenant_id, space_id, episode_id,
    recording_id, job_id, attempt_count, fencing_generation, envelope_digest
)
values (
    sqlc.arg(signaling_handle), sqlc.arg(capture_epoch), sqlc.arg(tenant_id),
    sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(recording_id),
    sqlc.arg(job_id), sqlc.arg(attempt_count), sqlc.arg(fencing_generation),
    sqlc.arg(envelope_digest)
)
on conflict (signaling_handle, capture_epoch) do nothing
returning *;

-- name: GetRecordingCaptureConnection :one
select *
from recording_capture_connections
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch);

-- name: LockRecordingCaptureConnection :one
select *
from recording_capture_connections
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
for update;

-- name: AdvanceRecordingCaptureCommandSequence :one
update recording_capture_connections
set next_sequence = next_sequence + 1
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
returning (next_sequence - 1)::bigint as sequence;

-- name: InsertRecordingCaptureCommand :one
insert into recording_capture_commands (
    signaling_handle, capture_epoch, sequence, recording_id, plan_revision,
    operation_kind, idempotency_key, request_bytes, request_fingerprint
)
values (
    sqlc.arg(signaling_handle), sqlc.arg(capture_epoch), sqlc.arg(sequence),
    sqlc.arg(recording_id), sqlc.arg(plan_revision), sqlc.arg(operation_kind),
    sqlc.arg(idempotency_key), sqlc.arg(request_bytes),
    sqlc.arg(request_fingerprint)
)
returning *;

-- name: GetRecordingCaptureCommand :one
select *
from recording_capture_commands
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
  and plan_revision = sqlc.arg(plan_revision)
  and operation_kind = sqlc.arg(operation_kind)
  and idempotency_key = sqlc.arg(idempotency_key);

-- name: GetFirstOpenRecordingCaptureCommand :one
select *
from recording_capture_commands
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
  and state in ('queued', 'leased', 'retryable', 'ambiguous')
order by sequence
limit 1
for update;

-- name: ClaimRecordingCaptureCommand :one
update recording_capture_commands
set state = 'leased',
    execution_attempt = execution_attempt + 1,
    execution_token = sqlc.arg(execution_token),
    execution_expires_at = sqlc.arg(execution_expires_at),
    leased_at = now(),
    provider_failure_class = null,
    provider_failure_code = null,
    provider_failure_retryable = null
where id = sqlc.arg(command_id)
  and state in ('queued', 'retryable')
  and not_before <= clock_timestamp()
returning *;

-- name: ReleaseRecordingCaptureCommand :one
update recording_capture_commands
set state = 'queued',
    execution_token = null,
    execution_expires_at = null,
    not_before = clock_timestamp()
where id = sqlc.arg(command_id)
  and state = 'leased'
  and execution_token = sqlc.arg(execution_token)
returning *;

-- name: SetRecordingCaptureConnectionActiveCommand :execrows
update recording_capture_connections
set active_command_id = sqlc.arg(command_id),
    active_execution_token = sqlc.arg(execution_token),
    active_execution_expires_at = sqlc.arg(execution_expires_at)
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
  and active_command_id is null;

-- name: ReserveRecordingCaptureProviderCall :one
update recording_capture_provider_rate_budget
set next_call_at = greatest(next_call_at, clock_timestamp()) + interval '25 milliseconds',
    updated_at = clock_timestamp()
where id = 1
returning (next_call_at - interval '25 milliseconds')::timestamptz as not_before;

-- name: CompleteRecordingCaptureCommand :one
update recording_capture_commands
set state = 'completed',
    execution_token = null,
    execution_expires_at = null,
    result_bytes = sqlc.arg(result_bytes),
    result_fingerprint = sqlc.arg(result_fingerprint),
    completed_at = now()
where id = sqlc.arg(command_id)
  and state = 'leased'
  and execution_token = sqlc.arg(execution_token)
returning *;

-- name: FailRecordingCaptureCommand :one
update recording_capture_commands
set state = sqlc.arg(state),
    execution_token = null,
    execution_expires_at = null,
    not_before = sqlc.arg(not_before),
    provider_failure_class = sqlc.arg(provider_failure_class),
    provider_failure_code = sqlc.narg(provider_failure_code),
    provider_failure_retryable = sqlc.arg(provider_failure_retryable),
    completed_at = case when sqlc.arg(state)::text = 'terminal' then now() else null end
where id = sqlc.arg(command_id)
  and state = 'leased'
  and execution_token = sqlc.arg(execution_token)
  and sqlc.arg(state)::text in ('retryable', 'terminal')
returning *;

-- name: MarkRecordingCaptureCommandAmbiguous :one
update recording_capture_commands
set state = 'ambiguous',
    execution_token = null,
    execution_expires_at = null,
    completed_at = now()
where id = sqlc.arg(command_id)
  and state = 'leased'
  and execution_expires_at <= clock_timestamp()
returning *;

-- name: ApplyRecordingCaptureConnectionProjection :one
update recording_capture_connections
set provider_connection_reference = coalesce(
        sqlc.narg(provider_connection_reference), provider_connection_reference
    ),
    state = sqlc.arg(connection_state),
    latest_plan_revision = greatest(latest_plan_revision, sqlc.arg(plan_revision)),
    negotiation_id = sqlc.narg(negotiation_id),
    negotiation_requirement = sqlc.arg(negotiation_requirement),
    negotiation_plan_revision = case
        when sqlc.narg(negotiation_id)::text is null then null
        else sqlc.arg(plan_revision)
    end
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
  and active_command_id = sqlc.arg(command_id)
  and active_execution_token = sqlc.arg(execution_token)
returning *;

-- name: ClearRecordingCaptureConnectionActiveCommand :execrows
update recording_capture_connections
set active_command_id = null,
    active_execution_token = null,
    active_execution_expires_at = null
where signaling_handle = sqlc.arg(signaling_handle)
  and capture_epoch = sqlc.arg(capture_epoch)
  and active_command_id = sqlc.arg(command_id)
  and (
      active_execution_token = sqlc.narg(execution_token)
      or sqlc.narg(execution_token)::uuid is null
  );
