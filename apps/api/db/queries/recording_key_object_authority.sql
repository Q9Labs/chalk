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
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and authority.lease_expires_at = sqlc.arg(lease_expires_at);

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
      and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
      and authority.capture_epoch = sqlc.arg(capture_epoch)
      and authority.envelope_digest = sqlc.arg(envelope_digest)
      and authority.lease_token = sqlc.arg(lease_token)
      and authority.lease_owner = sqlc.arg(lease_owner)
      and authority.lease_expires_at = sqlc.arg(lease_expires_at)
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
  and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
  and jobs.lease_expires_at > clock_timestamp()
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and authority.lease_expires_at = sqlc.arg(lease_expires_at);

-- name: GetRecordingBundleAllocation :one
select id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at
from recording_bundle_allocations
where id = sqlc.arg(id);

-- name: GetRecordingBundleAllocationByReservationRequest :one
select id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at
from recording_bundle_allocations
where reservation_request_id = sqlc.arg(reservation_request_id);

-- name: GetRecordingBundleAllocationByTokenHash :one
select id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at
from recording_bundle_allocations
where upload_token_hash = sqlc.arg(upload_token_hash);

-- name: ReserveRecordingBundleAllocation :one
with authorized_job as (
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
      and jobs.lease_expires_at = sqlc.arg(lease_expires_at)
      and jobs.lease_expires_at > clock_timestamp()
      and authority.capture_epoch = sqlc.arg(capture_epoch)
      and authority.envelope_digest = sqlc.arg(envelope_digest)
      and authority.lease_token = sqlc.arg(lease_token)
      and authority.lease_owner = sqlc.arg(lease_owner)
      and authority.lease_expires_at = sqlc.arg(lease_expires_at)
    for update of jobs
), locked_recording as (
    select recordings.id
    from recordings
    join authorized_job on authorized_job.id = recordings.id
    where recordings.id = sqlc.arg(recording_id)
      and recordings.tenant_id = sqlc.arg(tenant_id)
    for update of recordings
), next_values as (
    select
        greatest(
            coalesce((
                select max(sequence_number) + 1
                from recording_bundle_allocations
                where recording_id = sqlc.arg(recording_id)
            ), 0),
            coalesce((
                select max(sequence_number) + 1
                from recording_bundles
                where recording_id = sqlc.arg(recording_id)
            ), 0)
        )::bigint as sequence_number,
        greatest(
            coalesce((
                select max(allocation_version) + 1
                from recording_bundle_allocations
                where recording_id = sqlc.arg(recording_id)
            ), 1),
            coalesce((
                select max(sequence_number) + 1
                from recording_bundles
                where recording_id = sqlc.arg(recording_id)
            ), 1)
        )::bigint as allocation_version
), inserted as (
    insert into recording_bundle_allocations (
        id, tenant_id, episode_id, recording_id, job_id, object_handle,
        reservation_request_id, allocation_version,
        attempt_count, fencing_generation, capture_epoch, envelope_digest,
        sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
        media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
        expected_checksum, content_type, expires_at, encryption_context_digest, state
    )
    select sqlc.arg(allocation_id), sqlc.arg(tenant_id), sqlc.arg(episode_id), locked_recording.id,
        sqlc.arg(job_id), sqlc.arg(object_handle), sqlc.arg(reservation_request_id), next_values.allocation_version,
        sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch), sqlc.arg(envelope_digest),
        next_values.sequence_number, 'unknown', null, 0, 0, 0, 0,
        format('recordings/%s/capture/%s/bundles/%s/%s.bundle', sqlc.arg(recording_id)::text, sqlc.arg(capture_epoch)::text, next_values.sequence_number::text, sqlc.arg(allocation_id)::text),
        decode(md5('reserved:' || sqlc.arg(allocation_id)::text), 'hex'), 0, decode(repeat('00', 32), 'hex'),
        'application/octet-stream', clock_timestamp() + interval '30 minutes', sqlc.arg(encryption_context_digest), 'reserved'
    from locked_recording, next_values
    on conflict (job_id, attempt_count, reservation_request_id) do nothing
    returning id, tenant_id, episode_id, recording_id, job_id, object_handle,
        reservation_request_id, allocation_version,
        attempt_count, fencing_generation, capture_epoch, envelope_digest,
        sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
        media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
        expected_checksum, content_type, expires_at, encryption_context_digest,
        state, object_version, object_etag, object_checksum, manifest_digest,
        committed_at, created_at
)
select id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at
from inserted;

-- name: InsertRecordingBundleAllocation :one
insert into recording_bundle_allocations (
    id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest
)
values (
    sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(episode_id), sqlc.arg(recording_id), sqlc.arg(job_id), sqlc.arg(object_handle),
    sqlc.arg(reservation_request_id), sqlc.arg(allocation_version),
    sqlc.arg(attempt_count), sqlc.arg(fencing_generation), sqlc.arg(capture_epoch), sqlc.arg(envelope_digest),
    sqlc.arg(sequence_number), sqlc.arg(codec), sqlc.narg(layer), sqlc.arg(monotonic_start_millis), sqlc.arg(monotonic_end_millis),
    sqlc.arg(media_start_millis), sqlc.arg(media_end_millis), sqlc.arg(object_key), sqlc.arg(upload_token_hash), sqlc.arg(expected_byte_size),
    sqlc.arg(expected_checksum), sqlc.arg(content_type), sqlc.arg(expires_at), sqlc.arg(encryption_context_digest)
)
on conflict (id) do nothing
returning id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at;

-- name: FinalizeRecordingBundleAllocation :one
update recording_bundle_allocations
set state = 'allocated',
    upload_token_hash = sqlc.arg(upload_token_hash),
    expected_byte_size = sqlc.arg(expected_byte_size),
    expected_checksum = sqlc.arg(expected_checksum),
    content_type = sqlc.arg(content_type),
    expires_at = sqlc.arg(expires_at),
    codec = sqlc.arg(codec),
    layer = sqlc.narg(layer),
    monotonic_start_millis = sqlc.arg(monotonic_start_millis),
    monotonic_end_millis = sqlc.arg(monotonic_end_millis),
    media_start_millis = sqlc.arg(media_start_millis),
    media_end_millis = sqlc.arg(media_end_millis)
where recording_bundle_allocations.id = sqlc.arg(id)
  and recording_bundle_allocations.state in ('reserved', 'allocated')
  and recording_bundle_allocations.tenant_id = sqlc.arg(tenant_id)
  and recording_bundle_allocations.episode_id = sqlc.arg(episode_id)
  and recording_bundle_allocations.recording_id = sqlc.arg(recording_id)
  and recording_bundle_allocations.job_id = sqlc.arg(job_id)
  and recording_bundle_allocations.object_handle = sqlc.arg(object_handle)
  and recording_bundle_allocations.attempt_count = sqlc.arg(attempt_count)
  and recording_bundle_allocations.fencing_generation = sqlc.arg(fencing_generation)
  and recording_bundle_allocations.capture_epoch = sqlc.arg(capture_epoch)
  and recording_bundle_allocations.envelope_digest = sqlc.arg(envelope_digest)
  and recording_bundle_allocations.encryption_context_digest = sqlc.arg(encryption_context_digest)
  and exists (
      select 1
      from recording_jobs jobs
      join recording_job_attempt_authorities authority
        on authority.job_id = jobs.id
       and authority.attempt_count = jobs.attempt_count
       and authority.fencing_generation = jobs.fencing_generation
      where jobs.id = recording_bundle_allocations.job_id
        and jobs.tenant_id = sqlc.arg(tenant_id)
        and jobs.episode_id = sqlc.arg(episode_id)
        and jobs.recording_id = sqlc.arg(recording_id)
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
        and authority.lease_expires_at = sqlc.arg(lease_expires_at)
  )
returning id, tenant_id, episode_id, recording_id, job_id, object_handle,
    reservation_request_id, allocation_version,
    attempt_count, fencing_generation, capture_epoch, envelope_digest,
    sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
    media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
    expected_checksum, content_type, expires_at, encryption_context_digest,
    state, object_version, object_etag, object_checksum, manifest_digest,
    committed_at, created_at;

-- name: CommitRecordingBundleAllocation :one
with committed as (
    update recording_bundle_allocations
    set state = 'committed',
        object_version = sqlc.arg(object_version),
        object_etag = sqlc.arg(object_etag),
        object_checksum = sqlc.arg(object_checksum),
        manifest_digest = sqlc.arg(manifest_digest),
        committed_at = sqlc.arg(committed_at)
    where recording_bundle_allocations.id = sqlc.arg(id)
      and recording_bundle_allocations.state = 'allocated'
      and recording_bundle_allocations.tenant_id = sqlc.arg(tenant_id)
      and recording_bundle_allocations.episode_id = sqlc.arg(episode_id)
      and recording_bundle_allocations.recording_id = sqlc.arg(recording_id)
      and recording_bundle_allocations.job_id = sqlc.arg(job_id)
      and recording_bundle_allocations.object_handle = sqlc.arg(object_handle)
      and recording_bundle_allocations.attempt_count = sqlc.arg(attempt_count)
      and recording_bundle_allocations.fencing_generation = sqlc.arg(fencing_generation)
      and recording_bundle_allocations.capture_epoch = sqlc.arg(capture_epoch)
      and recording_bundle_allocations.envelope_digest = sqlc.arg(envelope_digest)
      and recording_bundle_allocations.encryption_context_digest = sqlc.arg(encryption_context_digest)
      and exists (
          select 1
          from recording_jobs jobs
          join recording_job_attempt_authorities authority
            on authority.job_id = jobs.id
           and authority.attempt_count = jobs.attempt_count
           and authority.fencing_generation = jobs.fencing_generation
          where jobs.id = recording_bundle_allocations.job_id
            and jobs.tenant_id = sqlc.arg(tenant_id)
            and jobs.episode_id = sqlc.arg(episode_id)
            and jobs.recording_id = sqlc.arg(recording_id)
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
            and authority.lease_expires_at = sqlc.arg(lease_expires_at)
      )
    returning id, tenant_id, episode_id, recording_id, job_id, object_handle,
        reservation_request_id, allocation_version,
        attempt_count, fencing_generation, capture_epoch, envelope_digest,
        sequence_number, codec, layer, monotonic_start_millis, monotonic_end_millis,
        media_start_millis, media_end_millis, object_key, upload_token_hash, expected_byte_size,
        expected_checksum, content_type, expires_at, encryption_context_digest,
        state, object_version, object_etag, object_checksum, manifest_digest,
        committed_at, created_at
), inserted_bundle as (
    insert into recording_bundles (
        id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation,
        object_key, content_type, codec, layer, byte_size, checksum,
        monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis,
        allocation_id, object_version, object_etag, capture_epoch, envelope_digest,
        encryption_context_digest, manifest_digest
    )
    select id, tenant_id, recording_id, job_id, sequence_number, fencing_generation,
        object_key, content_type, codec, layer, expected_byte_size, object_checksum,
        monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis,
        id, object_version, object_etag, capture_epoch, envelope_digest,
        encryption_context_digest, manifest_digest
    from committed
    returning id
)
select committed.id, committed.tenant_id, committed.episode_id, committed.recording_id, committed.job_id, committed.object_handle,
    committed.reservation_request_id, committed.allocation_version,
    committed.attempt_count, committed.fencing_generation, committed.capture_epoch, committed.envelope_digest,
    committed.sequence_number, committed.codec, committed.layer, committed.monotonic_start_millis, committed.monotonic_end_millis,
    committed.media_start_millis, committed.media_end_millis, committed.object_key, committed.upload_token_hash, committed.expected_byte_size,
    committed.expected_checksum, committed.content_type, committed.expires_at, committed.encryption_context_digest,
    committed.state, committed.object_version, committed.object_etag, committed.object_checksum, committed.manifest_digest,
    committed.committed_at, committed.created_at
from committed
join inserted_bundle on inserted_bundle.id = committed.id;
