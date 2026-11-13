-- name: ReserveRecordingRenderObject :one
with authorized as (
    select inputs.render_job_id
    from recording_render_inputs inputs
    join recording_jobs jobs on jobs.id = inputs.render_job_id
    join recording_pipelines pipelines on pipelines.recording_id = inputs.recording_id
    join episodes on episodes.id = inputs.episode_id
    where inputs.render_input_handle = sqlc.arg(render_input_handle)
      and inputs.tenant_id = sqlc.arg(tenant_id)
      and inputs.space_id = sqlc.arg(space_id)
      and inputs.episode_id = sqlc.arg(episode_id)
      and inputs.recording_id = sqlc.arg(recording_id)
      and inputs.render_job_id = sqlc.arg(render_job_id)
      and inputs.object_handle = sqlc.arg(object_handle)
      and inputs.attempt_count = sqlc.arg(attempt_count)
      and inputs.fencing_generation = sqlc.arg(fencing_generation)
      and inputs.capture_epoch = sqlc.arg(capture_epoch)
      and inputs.envelope_digest = sqlc.arg(envelope_digest)
      and inputs.key_handle = sqlc.arg(key_handle)
      and jobs.kind in ('render', 'transcription')
      and jobs.state = 'leased'
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
      and pipelines.capture_completed_at +
          ((case when jobs.kind = 'transcription'
              then recording_transcription_source_window_seconds(episodes.config_snapshot)
              else recording_deferred_retention_seconds(episodes.config_snapshot)
          end) * interval '1 second') > clock_timestamp()
    for update of jobs
), next_version as (
    select coalesce(max(allocation_version), 0) + 1 as value
    from recording_render_object_allocations
    where recording_id = sqlc.arg(recording_id)
)
insert into recording_render_object_allocations (
    id, reservation_request_id, allocation_version, tenant_id, episode_id,
    recording_id, render_job_id, render_input_handle, object_handle,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    purpose, state, object_key
)
select sqlc.arg(allocation_id), sqlc.arg(reservation_request_id), next_version.value,
    sqlc.arg(tenant_id), sqlc.arg(episode_id), sqlc.arg(recording_id),
    authorized.render_job_id, sqlc.arg(render_input_handle), sqlc.arg(object_handle),
    sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch),
    sqlc.arg(envelope_digest), sqlc.arg(purpose), 'reserved', sqlc.arg(object_key)
from authorized, next_version
returning *;

-- name: GetRecordingRenderObjectByReservation :one
select *
from recording_render_object_allocations
where object_handle = sqlc.arg(object_handle)
  and reservation_request_id = sqlc.arg(reservation_request_id);

-- name: GetRecordingRenderObject :one
select allocations.*
from recording_render_object_allocations allocations
join recording_render_inputs inputs on inputs.render_input_handle = allocations.render_input_handle
join recording_jobs jobs on jobs.id = allocations.render_job_id
where allocations.id = sqlc.arg(allocation_id)
  and inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and jobs.kind in ('render', 'transcription')
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp();

-- name: GetRecordingRenderObjectByTokenHash :one
select allocations.*
from recording_render_object_allocations allocations
join recording_render_inputs inputs on inputs.render_input_handle = allocations.render_input_handle
join recording_jobs jobs on jobs.id = allocations.render_job_id
where allocations.upload_token_hash = sqlc.arg(upload_token_hash)
  and inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and jobs.kind in ('render', 'transcription')
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp();

-- name: FinalizeRecordingRenderObject :one
update recording_render_object_allocations allocations
set state = 'allocated',
    expected_content_type = sqlc.arg(expected_content_type),
    expected_byte_size = sqlc.arg(expected_byte_size),
    expected_sha256 = sqlc.arg(expected_sha256),
    expected_duration_millis = sqlc.narg(expected_duration_millis),
    upload_token_hash = sqlc.arg(upload_token_hash),
    upload_expires_at = sqlc.arg(upload_expires_at)
from recording_jobs jobs
where allocations.id = sqlc.arg(allocation_id)
  and allocations.render_job_id = jobs.id
  and (
      allocations.state = 'reserved'
      or (
          allocations.state = 'allocated'
          and allocations.expected_content_type = sqlc.arg(expected_content_type)
          and allocations.expected_byte_size = sqlc.arg(expected_byte_size)
          and allocations.expected_sha256 = sqlc.arg(expected_sha256)
          and allocations.expected_duration_millis is not distinct from sqlc.narg(expected_duration_millis)
      )
  )
  and allocations.attempt_count = jobs.attempt_count
  and allocations.fencing_generation = jobs.fencing_generation
  and jobs.kind in ('render', 'transcription')
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
returning allocations.*;

-- name: CommitRecordingRenderObject :one
update recording_render_object_allocations allocations
set state = 'committed', object_version = sqlc.arg(object_version),
    object_etag = sqlc.arg(object_etag), object_content_type = sqlc.arg(object_content_type),
    object_byte_size = sqlc.arg(object_byte_size), object_sha256 = sqlc.arg(object_sha256),
    committed_at = sqlc.arg(committed_at)
from recording_jobs jobs
where allocations.id = sqlc.arg(allocation_id)
  and allocations.render_job_id = jobs.id
  and allocations.state = 'allocated'
  and allocations.attempt_count = jobs.attempt_count
  and allocations.fencing_generation = jobs.fencing_generation
  and jobs.kind in ('render', 'transcription')
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
	and allocations.upload_token_hash = sqlc.arg(upload_token_hash)
	and allocations.upload_expires_at > clock_timestamp()
	and allocations.expected_content_type = sqlc.arg(object_content_type)
	and allocations.expected_byte_size = sqlc.arg(object_byte_size)
	and allocations.expected_sha256 = sqlc.arg(object_sha256)
returning allocations.*;
