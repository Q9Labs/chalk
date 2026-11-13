-- name: GetRecordingDataKey :one
select recording_data_keys.recording_id, recording_data_keys.capture_epoch, recording_data_keys.tenant_id, recording_data_keys.episode_id, recording_data_keys.job_id,
    recording_data_keys.attempt_count, recording_data_keys.fencing_generation, recording_data_keys.key_handle, recording_data_keys.environment, recording_data_keys.envelope_digest,
    recording_data_keys.encryption_context_digest, recording_data_keys.ciphertext_blob, recording_data_keys.created_at
from recording_data_keys
join recording_jobs jobs on jobs.id = recording_data_keys.job_id
join recording_job_attempt_authorities authority
  on authority.job_id = jobs.id
 and authority.attempt_count = jobs.attempt_count
 and authority.fencing_generation = jobs.fencing_generation
where recording_data_keys.recording_id = sqlc.arg(recording_id)
  and recording_data_keys.capture_epoch = sqlc.arg(capture_epoch)
  and recording_data_keys.tenant_id = sqlc.arg(tenant_id)
  and recording_data_keys.episode_id = sqlc.arg(episode_id)
  and recording_data_keys.job_id = sqlc.arg(job_id)
  and recording_data_keys.attempt_count = sqlc.arg(attempt_count)
  and recording_data_keys.fencing_generation = sqlc.arg(fencing_generation)
  and recording_data_keys.envelope_digest = sqlc.arg(envelope_digest)
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at >= sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and sqlc.arg(lease_expires_at)::timestamptz > clock_timestamp();

-- name: InsertRecordingDataKey :one
with authorized as (
    select jobs.id
    from recording_jobs jobs
    join recording_job_attempt_authorities authority
      on authority.job_id = jobs.id
     and authority.attempt_count = jobs.attempt_count
     and authority.fencing_generation = jobs.fencing_generation
    where jobs.id = sqlc.arg(job_id)
      and jobs.tenant_id = sqlc.arg(tenant_id)
      and jobs.episode_id = sqlc.arg(episode_id)
      and jobs.recording_id = sqlc.arg(recording_id)
      and jobs.state = 'leased'
      and jobs.attempt_count = sqlc.arg(attempt_count)
      and jobs.fencing_generation = sqlc.arg(fencing_generation)
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at >= sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
      and authority.capture_epoch = sqlc.arg(capture_epoch)
      and authority.envelope_digest = sqlc.arg(envelope_digest)
      and authority.lease_token = sqlc.arg(lease_token)
      and authority.lease_owner = sqlc.arg(lease_owner)
      and sqlc.arg(lease_expires_at)::timestamptz > clock_timestamp()
)
insert into recording_data_keys (
    recording_id, capture_epoch, tenant_id, episode_id, job_id,
    attempt_count, fencing_generation, key_handle, environment, envelope_digest,
    encryption_context_digest, ciphertext_blob
)
select sqlc.arg(recording_id), sqlc.arg(capture_epoch), sqlc.arg(tenant_id), sqlc.arg(episode_id), authorized.id,
    sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(key_handle), sqlc.arg(environment), sqlc.arg(envelope_digest),
    sqlc.arg(encryption_context_digest), sqlc.arg(ciphertext_blob)
from authorized
on conflict (recording_id, capture_epoch) do nothing
returning recording_id, capture_epoch, tenant_id, episode_id, job_id,
    attempt_count, fencing_generation, key_handle, environment, envelope_digest,
    encryption_context_digest, ciphertext_blob, created_at;

-- name: AuthorizeRecordingJobLease :one
select jobs.id
from recording_jobs jobs
join recording_job_attempt_authorities authority
  on authority.job_id = jobs.id
 and authority.attempt_count = jobs.attempt_count
 and authority.fencing_generation = jobs.fencing_generation
where jobs.id = sqlc.arg(job_id)
  and jobs.tenant_id = sqlc.arg(tenant_id)
  and jobs.episode_id = sqlc.arg(episode_id)
  and jobs.recording_id = sqlc.arg(recording_id)
  and jobs.state = 'leased'
  and jobs.attempt_count = sqlc.arg(attempt_count)
  and jobs.fencing_generation = sqlc.arg(fencing_generation)
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at >= sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and sqlc.arg(lease_expires_at)::timestamptz > clock_timestamp();
