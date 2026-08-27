-- name: LockRecordingCaptureLifecycleAuthority :one
select
    authority.envelope_digest,
    authority.job_id,
    authority.attempt_count,
    authority.fencing_generation,
    authority.capture_epoch,
    jobs.tenant_id,
    reservations.space_id,
    jobs.episode_id,
    jobs.recording_id,
    jobs.lease_owner,
    jobs.lease_token,
    jobs.lease_expires_at,
    sync_recordings.status as recording_status,
    sync_recordings.start_external_operation_id,
    sync_recordings.stop_external_operation_id
from recording_job_attempt_authorities authority
join recording_jobs jobs on jobs.id = authority.job_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_reservations reservations on reservations.id = pipelines.reservation_id
join sync_recordings
  on sync_recordings.tenant_id = jobs.tenant_id
 and sync_recordings.space_id = reservations.space_id
 and sync_recordings.episode_id = jobs.episode_id
 and sync_recordings.recording_id = jobs.recording_id
where authority.job_id = sqlc.arg(job_id)
  and authority.attempt_count = sqlc.arg(attempt_count)
  and authority.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and jobs.kind = 'capture'
  and jobs.state = 'leased'
  and jobs.tenant_id = sqlc.arg(tenant_id)
  and jobs.episode_id = sqlc.arg(episode_id)
  and jobs.recording_id = sqlc.arg(recording_id)
  and reservations.space_id = sqlc.arg(space_id)
  and jobs.attempt_count = sqlc.arg(attempt_count)
  and jobs.fencing_generation = sqlc.arg(fencing_generation)
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.lease_expires_at = sqlc.arg(lease_expires_at)
for update of jobs, sync_recordings;

-- name: LockRecordingCaptureLifecycleOperation :one
select *
from sync_external_operations
where tenant_id = sqlc.arg(tenant_id)
  and space_id = sqlc.arg(space_id)
  and episode_id = sqlc.arg(episode_id)
  and operation_name = sqlc.arg(operation_name)
  and request_key = sqlc.arg(request_key)
for update;

-- name: InsertRecordingCaptureLifecycleOperation :one
insert into sync_external_operations (
    tenant_id,
    space_id,
    episode_id,
    external_operation_id,
    request_key,
    request_fingerprint,
    operation_name,
    recording_id,
    journey_id,
    parent_journey_event_id,
    producing_trace_id,
    producing_span_id,
    producing_traceparent,
    producing_tracestate,
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
    sqlc.arg(recording_id),
    sqlc.narg(journey_id),
    sqlc.narg(parent_journey_event_id),
    sqlc.narg(producing_trace_id),
    sqlc.narg(producing_span_id),
    sqlc.narg(producing_traceparent),
    sqlc.narg(producing_tracestate),
    sqlc.arg(payload),
    false
)
on conflict (tenant_id, episode_id, operation_name, request_key) do nothing
returning *;
