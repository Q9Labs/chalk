-- name: GetRecordingArtifact :one
select recording_id, tenant_id, render_job_id, object_key, content_type,
    byte_size, checksum, duration_millis, committed_at, expires_at, created_at
from recording_artifacts
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id);

-- name: AuthorizeRecordingArtifactReplay :one
select true
from recording_job_attempt_authorities authority
join recording_jobs on recording_jobs.id = authority.job_id
where recording_jobs.id = sqlc.arg(render_job_id)
  and recording_jobs.tenant_id = sqlc.arg(tenant_id)
  and recording_jobs.recording_id = sqlc.arg(recording_id)
  and recording_jobs.kind = 'render'
  and authority.kind = recording_jobs.kind
  and authority.attempt_count = sqlc.arg(attempt_count)
  and authority.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner);

-- name: UpsertRecordingPoolHealth :one
insert into recording_pool_health (role, admission_open, ready_capacity, reason, observed_at)
values (sqlc.arg(role), sqlc.arg(admission_open), sqlc.arg(ready_capacity), sqlc.arg(reason), sqlc.arg(observed_at))
on conflict (role) do update set
    admission_open = excluded.admission_open,
    ready_capacity = excluded.ready_capacity,
    reason = excluded.reason,
    observed_at = excluded.observed_at,
    updated_at = now()
returning role, admission_open, ready_capacity, reason, observed_at, updated_at;

-- name: GetRecordingPoolHealth :one
select role, admission_open, ready_capacity, reason, observed_at, updated_at
from recording_pool_health
where role = sqlc.arg(role);

-- name: InsertRecordingBundle :one
with authorized as (
    select id
    from recording_jobs
    where id = sqlc.arg(capture_job_id)
      and tenant_id = sqlc.arg(tenant_id)
      and recording_id = sqlc.arg(recording_id)
      and kind = 'capture'
      and state = 'leased'
      and recording_jobs.attempt_count = sqlc.arg(attempt_count)
      and recording_jobs.fencing_generation = sqlc.arg(fencing_generation)
      and recording_jobs.lease_token = sqlc.arg(lease_token)
      and recording_jobs.lease_owner = sqlc.arg(lease_owner)
      and recording_jobs.lease_expires_at > now()
      and exists (
          select 1 from recording_job_attempt_authorities authority
          where authority.job_id = recording_jobs.id
            and authority.kind = recording_jobs.kind
            and authority.attempt_count = sqlc.arg(attempt_count)
            and authority.fencing_generation = sqlc.arg(fencing_generation)
            and authority.capture_epoch = sqlc.arg(capture_epoch)
            and authority.envelope_digest = sqlc.arg(envelope_digest)
            and authority.lease_token = sqlc.arg(lease_token)
            and authority.lease_owner = sqlc.arg(lease_owner)
      )
)
insert into recording_bundles (
    id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation,
    object_key, content_type, codec, layer, byte_size, checksum,
    monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis
)
select sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(recording_id), sqlc.arg(capture_job_id),
    sqlc.arg(sequence_number), sqlc.arg(fencing_generation), sqlc.arg(object_key),
    sqlc.arg(content_type), sqlc.arg(codec), sqlc.narg(layer), sqlc.arg(byte_size), sqlc.arg(checksum),
    sqlc.arg(monotonic_start_millis), sqlc.arg(monotonic_end_millis),
    sqlc.arg(media_start_millis), sqlc.arg(media_end_millis)
from authorized
returning id, tenant_id, recording_id, capture_job_id, sequence_number, fencing_generation,
    object_key, content_type, codec, layer, byte_size, checksum,
    monotonic_start_millis, monotonic_end_millis, media_start_millis, media_end_millis, created_at;

-- name: CommitRecordingArtifact :one
with authorized as (
    select recording_jobs.id, recording_jobs.recording_id, recording_jobs.tenant_id,
        recording_pipelines.capture_completed_at, episodes.config_snapshot
    from recording_jobs
    join recording_pipelines on recording_pipelines.recording_id = recording_jobs.recording_id
    join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
        and recording_reservations.recording_id = recording_jobs.recording_id
        and recording_reservations.tenant_id = recording_jobs.tenant_id
    join recordings on recordings.id = recording_jobs.recording_id
        and recordings.tenant_id = recording_jobs.tenant_id
        and recordings.space_id = recording_reservations.space_id
        and recordings.episode_id = recording_reservations.episode_id
    join episodes on episodes.id = recordings.episode_id
    where recording_jobs.id = sqlc.arg(render_job_id)
      and recording_jobs.tenant_id = sqlc.arg(tenant_id)
      and recording_jobs.recording_id = sqlc.arg(recording_id)
      and recording_jobs.kind = 'render'
      and recording_jobs.state = 'leased'
      and recording_jobs.attempt_count = sqlc.arg(attempt_count)
      and recording_jobs.fencing_generation = sqlc.arg(fencing_generation)
      and recording_jobs.lease_token = sqlc.arg(lease_token)
      and recording_jobs.lease_owner = sqlc.arg(lease_owner)
      and recording_jobs.lease_expires_at > now()
      and exists (
          select 1 from recording_job_attempt_authorities authority
          where authority.job_id = recording_jobs.id
            and authority.kind = recording_jobs.kind
            and authority.attempt_count = sqlc.arg(attempt_count)
            and authority.fencing_generation = sqlc.arg(fencing_generation)
            and authority.capture_epoch = sqlc.arg(capture_epoch)
            and authority.envelope_digest = sqlc.arg(envelope_digest)
            and authority.lease_token = sqlc.arg(lease_token)
            and authority.lease_owner = sqlc.arg(lease_owner)
      )
      and recording_pipelines.state = 'rendering'
      and recording_pipelines.capture_completed_at +
          (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second') > clock_timestamp()
      and recordings.status in ('pending', 'processing')
    for update of recordings
), artifact as (
    insert into recording_artifacts (
        recording_id, tenant_id, render_job_id, object_key, content_type,
        byte_size, checksum, duration_millis, committed_at, expires_at
    )
    select authorized.recording_id, authorized.tenant_id, authorized.id,
        sqlc.arg(object_key), sqlc.arg(content_type), sqlc.arg(byte_size),
        sqlc.arg(checksum), sqlc.arg(duration_millis), now(),
        authorized.capture_completed_at +
            (recording_deferred_retention_seconds(authorized.config_snapshot) * interval '1 second')
    from authorized
    on conflict (recording_id) do nothing
    returning recording_id, tenant_id, render_job_id, object_key, content_type,
        byte_size, checksum, duration_millis, committed_at, expires_at, created_at
), artifact_cleanup as (
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), artifact.tenant_id, artifact.recording_id, null,
        artifact.object_key, 'recording_source', artifact.expires_at
    from artifact
    on conflict (recording_id, object_key) do update set
        due_at = least(transcription_cleanup_jobs.due_at, excluded.due_at),
        updated_at = now()
    returning id
), completed as (
    update recording_jobs
    set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    from artifact
    where recording_jobs.id = artifact.render_job_id
    returning recording_jobs.recording_id
), public_recording as (
    update recordings
    set status = 'completed',
        storage_provider = 'r2',
        storage_key = artifact.object_key,
        storage_content_type = artifact.content_type,
        storage_size = artifact.byte_size,
        storage_checksum = artifact.checksum,
        duration_millis = artifact.duration_millis,
        completed_at = artifact.committed_at,
        updated_at = now()
    from artifact
    join completed on completed.recording_id = artifact.recording_id
    where recordings.id = artifact.recording_id
      and recordings.tenant_id = artifact.tenant_id
    returning recordings.id
), pipeline as (
    update recording_pipelines
    set state = 'committed', committed_at = now(), updated_at = now()
    from public_recording
    where recording_pipelines.recording_id = public_recording.id
    returning recording_pipelines.recording_id
)
select artifact.recording_id, artifact.tenant_id, artifact.render_job_id,
    artifact.object_key, artifact.content_type, artifact.byte_size, artifact.checksum,
    artifact.duration_millis, artifact.committed_at, artifact.created_at
from artifact
join pipeline on pipeline.recording_id = artifact.recording_id
cross join (select count(*) from artifact_cleanup) cleanup;

-- name: ListRecordingJobsForReconciliation :many
select id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at, result_metadata
from recording_jobs
where (state = 'leased' and lease_expires_at <= now())
   or (state = 'pending' and available_at < sqlc.arg(stale_before))
   or (state = 'terminal_failure' and terminal_at < sqlc.arg(terminal_before))
order by updated_at, id
limit sqlc.arg(limit_count)::integer;
-- name: GetRecordingCaptureJobEnvelope :one
select envelope_bytes, envelope_digest
from recording_job_attempt_authorities
where job_id = sqlc.arg(job_id) and kind = 'capture'
order by attempt_count, fencing_generation
limit 1;

-- name: GetRecordingCaptureAttemptEnvelope :one
select envelope_bytes, envelope_digest
from recording_job_attempt_authorities
where job_id = sqlc.arg(job_id) and kind = 'capture' and envelope_digest = sqlc.arg(envelope_digest)
limit 1;

-- name: DrainCaptureStopPublications :exec
select recording_drain_capture_stop_publications(sqlc.arg(observed_at)::timestamptz, 100);

-- name: ListHeldCaptureSlots :many
select
    job.id,
    job.tenant_id,
    job.recording_id,
    job.episode_id,
    job.lease_expires_at,
    coalesce(
        (select max(authority.issued_at)
         from recording_job_attempt_authorities authority
         where authority.job_id = job.id and authority.attempt_count = job.attempt_count),
        job.updated_at
    )::timestamptz as claimed_at
from recording_jobs job
where job.kind = 'capture' and job.state = 'leased'
order by claimed_at, job.id
limit sqlc.arg(row_limit);

-- name: InsertRecordingClaimedEvent :exec
-- The claim lag is the time the capture waited, from becoming available to this claim. The event
-- joins the Recording's start journey, so a slow start reads off the Episode's own timeline.
insert into observability_journey_events (
    event_id, journey_id, sequence, occurred_at, name, phase, state,
    origin_kind, first_observed_layer, upstream_visibility, parent_event_id, trace_id, span_id, attributes
)
select gen_random_uuid(), coalesce(start_operation.journey_id, job.recording_id),
    coalesce((select max(sequence) + 1 from observability_journey_events
              where journey_id = coalesce(start_operation.journey_id, job.recording_id)), 0),
    now(), 'recording.claimed', 'capture_claim', 'succeeded', 'server', 'api', 'visible',
    start_operation.parent_journey_event_id, sqlc.narg(trace_id), sqlc.narg(span_id),
    jsonb_build_object('recording_id', job.recording_id, 'job_id', job.id, 'attempt_count', job.attempt_count,
        'claim_lag_ms', greatest(0, floor(extract(epoch from (clock_timestamp() - job.available_at)) * 1000))::bigint,
        'placement', case when exists (select 1 from recording_colocated_capture_workers node
                                       where node.worker_id::text = sqlc.arg(lease_owner)::text)
                          then 'colocated' else 'fleet' end)
from recording_jobs job
left join sync_recordings recording on recording.recording_id = job.recording_id and recording.tenant_id = job.tenant_id
left join sync_external_operations start_operation on start_operation.external_operation_id = recording.start_external_operation_id
    and start_operation.tenant_id = job.tenant_id and start_operation.episode_id = job.episode_id
    and start_operation.recording_id = job.recording_id and start_operation.operation_name = 'start_recording'
where job.id = sqlc.arg(job_id) and job.kind = 'capture';
