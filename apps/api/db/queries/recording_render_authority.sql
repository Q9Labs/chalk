-- name: InsertRecordingRenderInput :one
with authorized as (
    select jobs.id
    from recording_jobs jobs
    join recording_job_attempt_authorities authority
      on authority.job_id = jobs.id
     and authority.attempt_count = jobs.attempt_count
     and authority.fencing_generation = jobs.fencing_generation
    join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
    join recording_reservations reservations on reservations.id = pipelines.reservation_id
    join recording_data_keys data_keys
      on data_keys.recording_id = jobs.recording_id
     and data_keys.capture_epoch = pipelines.capture_epoch
    where jobs.id = sqlc.arg(render_job_id)
      and jobs.tenant_id = sqlc.arg(tenant_id)
      and jobs.episode_id = sqlc.arg(episode_id)
      and jobs.recording_id = sqlc.arg(recording_id)
      and jobs.kind in ('render', 'transcription')
      and jobs.state = 'leased'
      and jobs.attempt_count = sqlc.arg(attempt_count)
      and jobs.fencing_generation = sqlc.arg(fencing_generation)
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
      and authority.capture_epoch = sqlc.arg(capture_epoch)
      and authority.envelope_digest = sqlc.arg(envelope_digest)
      and authority.lease_token = sqlc.arg(lease_token)
      and authority.lease_owner = sqlc.arg(lease_owner)
      and ((jobs.kind = 'render' and pipelines.state = 'rendering')
        or (jobs.kind = 'transcription' and pipelines.state <> 'deleted'))
      and pipelines.capture_completed_at is not null
      and reservations.space_id = sqlc.arg(space_id)
      and reservations.episode_id = sqlc.arg(episode_id)
      and data_keys.key_handle = sqlc.arg(key_handle)
)
insert into recording_render_inputs (
    render_input_handle, tenant_id, space_id, episode_id, recording_id,
    render_job_id, attempt_count, fencing_generation, capture_epoch,
    envelope_digest, key_handle, object_handle, presentation_handle,
    presentation_schema_version, presentation_profile_version,
    presentation_sha256, presentation_duration_millis, capture_ready_at
)
select sqlc.arg(render_input_handle), sqlc.arg(tenant_id), sqlc.arg(space_id),
    sqlc.arg(episode_id), sqlc.arg(recording_id), authorized.id,
    sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch),
    sqlc.arg(envelope_digest), sqlc.arg(key_handle), sqlc.arg(object_handle),
    sqlc.arg(presentation_handle), sqlc.arg(presentation_schema_version),
    sqlc.arg(presentation_profile_version), sqlc.arg(presentation_sha256),
    sqlc.arg(presentation_duration_millis), sqlc.arg(capture_ready_at)
from authorized
returning *;

-- name: GetRecordingRenderInputByAttempt :one
select *
from recording_render_inputs
where render_job_id = sqlc.arg(render_job_id)
  and attempt_count = sqlc.arg(attempt_count)
  and fencing_generation = sqlc.arg(fencing_generation);

-- name: AuthorizeRecordingRenderInput :one
select inputs.*,
    (pipelines.capture_completed_at +
        ((case when jobs.kind = 'transcription'
            then recording_transcription_source_window_seconds(episodes.config_snapshot)
            else recording_deferred_retention_seconds(episodes.config_snapshot)
        end) * interval '1 second'))::timestamptz as source_expires_at
from recording_render_inputs inputs
join recording_jobs jobs on jobs.id = inputs.render_job_id
join recording_job_attempt_authorities authority
  on authority.job_id = jobs.id
 and authority.attempt_count = inputs.attempt_count
 and authority.fencing_generation = inputs.fencing_generation
join recording_pipelines pipelines on pipelines.recording_id = inputs.recording_id
join episodes on episodes.id = inputs.episode_id
where inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and jobs.kind in ('render', 'transcription')
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.capture_epoch = inputs.capture_epoch
  and authority.envelope_digest = inputs.envelope_digest
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and ((jobs.kind = 'render' and pipelines.state = 'rendering')
    or (jobs.kind = 'transcription' and pipelines.state <> 'deleted'))
	and pipelines.capture_completed_at is not null
  and pipelines.capture_completed_at +
      ((case when jobs.kind = 'transcription'
          then recording_transcription_source_window_seconds(episodes.config_snapshot)
          else recording_deferred_retention_seconds(episodes.config_snapshot)
      end) * interval '1 second') > clock_timestamp()
for share of jobs;

-- name: ListRecordingRenderCaptureObjects :many
select allocations.capture_epoch, allocations.job_id as capture_job_id,
    allocations.envelope_digest, data_keys.key_handle, capture_authorities.envelope_bytes,
    allocations.sequence_number, allocations.object_key,
    allocations.object_version, allocations.object_etag, allocations.content_type,
    allocations.expected_byte_size as byte_size, allocations.object_checksum as sha256,
    allocations.monotonic_start_millis, allocations.monotonic_end_millis,
    allocations.media_start_millis, allocations.media_end_millis,
    allocations.codec, allocations.layer
from recording_render_inputs inputs
join recording_jobs render_jobs on render_jobs.id = inputs.render_job_id
join recording_jobs capture_jobs
  on capture_jobs.recording_id = inputs.recording_id
 and capture_jobs.kind = 'capture'
 and capture_jobs.state = 'succeeded'
join recording_bundle_allocations allocations
  on allocations.job_id = capture_jobs.id
 and allocations.recording_id = inputs.recording_id
 and allocations.capture_epoch <= inputs.capture_epoch
 and allocations.state = 'committed'
join recording_job_attempt_authorities capture_authorities
  on capture_authorities.job_id = allocations.job_id
 and capture_authorities.attempt_count = allocations.attempt_count
 and capture_authorities.fencing_generation = allocations.fencing_generation
 and capture_authorities.capture_epoch = allocations.capture_epoch
 and capture_authorities.envelope_digest = allocations.envelope_digest
 and capture_authorities.kind = 'capture'
left join recording_data_keys data_keys
  on data_keys.recording_id = allocations.recording_id
 and data_keys.capture_epoch = allocations.capture_epoch
 and data_keys.tenant_id = allocations.tenant_id
 and data_keys.episode_id = allocations.episode_id
 and data_keys.job_id = allocations.job_id
 and data_keys.attempt_count = allocations.attempt_count
 and data_keys.fencing_generation = allocations.fencing_generation
 and data_keys.envelope_digest = allocations.envelope_digest
 and data_keys.encryption_context_digest = allocations.encryption_context_digest
where inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and render_jobs.state = 'leased'
  and render_jobs.attempt_count = sqlc.arg(attempt_count)
  and render_jobs.fencing_generation = sqlc.arg(fencing_generation)
order by allocations.sequence_number;

-- name: GetRecordingRenderCaptureKey :one
select data_keys.recording_id, data_keys.capture_epoch, data_keys.tenant_id,
    data_keys.episode_id, data_keys.job_id, data_keys.key_handle,
    data_keys.environment, data_keys.envelope_digest,
    data_keys.encryption_context_digest, data_keys.ciphertext_blob,
    data_keys.created_at
from recording_render_inputs inputs
join recording_jobs render_jobs on render_jobs.id = inputs.render_job_id
join recording_pipelines pipelines on pipelines.recording_id = inputs.recording_id
join episodes on episodes.id = inputs.episode_id
join recording_data_keys data_keys
  on data_keys.recording_id = inputs.recording_id
 and data_keys.capture_epoch = sqlc.arg(requested_capture_epoch)
where inputs.render_input_handle = sqlc.arg(render_input_handle)
  and inputs.tenant_id = sqlc.arg(tenant_id)
  and inputs.space_id = sqlc.arg(space_id)
  and inputs.episode_id = sqlc.arg(episode_id)
  and inputs.recording_id = sqlc.arg(recording_id)
  and inputs.render_job_id = sqlc.arg(render_job_id)
  and inputs.attempt_count = sqlc.arg(attempt_count)
  and inputs.fencing_generation = sqlc.arg(fencing_generation)
  and inputs.capture_epoch = sqlc.arg(capture_epoch)
  and inputs.envelope_digest = sqlc.arg(envelope_digest)
  and inputs.key_handle = sqlc.arg(key_handle)
  and inputs.object_handle = sqlc.arg(object_handle)
  and render_jobs.kind in ('render', 'transcription')
  and render_jobs.state = 'leased'
  and render_jobs.lease_token = sqlc.arg(lease_token)
  and render_jobs.lease_owner = sqlc.arg(lease_owner)
  and render_jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and render_jobs.lease_expires_at > clock_timestamp()
  and pipelines.capture_completed_at +
      ((case when render_jobs.kind = 'transcription'
          then recording_transcription_source_window_seconds(episodes.config_snapshot)
          else recording_deferred_retention_seconds(episodes.config_snapshot)
      end) * interval '1 second') > clock_timestamp()
  and exists (
      select 1
      from recording_bundle_allocations allocations
      where allocations.recording_id = data_keys.recording_id
        and allocations.capture_epoch = data_keys.capture_epoch
        and allocations.tenant_id = data_keys.tenant_id
        and allocations.episode_id = data_keys.episode_id
        and allocations.job_id = data_keys.job_id
        and allocations.attempt_count = data_keys.attempt_count
        and allocations.fencing_generation = data_keys.fencing_generation
        and allocations.envelope_digest = data_keys.envelope_digest
        and allocations.encryption_context_digest = data_keys.encryption_context_digest
        and allocations.state = 'committed'
  );
