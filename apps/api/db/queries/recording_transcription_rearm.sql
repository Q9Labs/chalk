-- name: ListRecordingTranscriptionRearmCandidates :many
select recordings.id as recording_id, recordings.tenant_id, recordings.episode_id,
    jobs.id as job_id, jobs.state, jobs.error_code, jobs.attempt_count, jobs.fencing_generation,
    jobs.terminal_at, jobs.created_at,
    recording_transcription_source_window_seconds(episodes.config_snapshot)::bigint as source_window_seconds,
    least(
        pipelines.capture_completed_at + (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
        (select min(cleanup.due_at) from transcription_cleanup_jobs cleanup
         where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
           and cleanup.state = 'pending')
    )::timestamptz as capture_retention_expires_at,
    (pipelines.capture_completed_at is not null and exists (
        select 1 from recording_jobs capture
        where capture.recording_id = jobs.recording_id and capture.kind = 'capture' and capture.state = 'succeeded'
    ))::boolean as capture_succeeded,
    (episodes.config_snapshot #>> '{artifact_policy,transcription,mode}')::text as transcription_mode,
    exists(select 1 from recording_transcription_sources source where source.recording_id = jobs.recording_id) as has_transcription_source,
    exists(select 1 from transcriptions transcript where transcript.recording_id = jobs.recording_id) as has_transcript,
    exists(select 1 from recording_data_keys keys where keys.recording_id = jobs.recording_id and keys.capture_epoch = pipelines.capture_epoch) as has_data_key,
    exists(select 1 from recording_presentations presentations where presentations.recording_id = jobs.recording_id) as has_presentation,
    (select count(*) from recording_bundles bundles where bundles.recording_id = jobs.recording_id)::integer as bundle_count,
    array(
        select bundles.object_key from recording_bundles bundles where bundles.recording_id = jobs.recording_id
        union
        select presentations.presentation_object_key from recording_presentations presentations where presentations.recording_id = jobs.recording_id
        union
        select presentations.asset_manifest_object_key from recording_presentations presentations where presentations.recording_id = jobs.recording_id
        union
        select assets.object_key from recording_presentation_assets assets
        join recording_presentations presentations using (presentation_handle)
        where presentations.recording_id = jobs.recording_id
    )::text[] as object_keys,
    exists(
        select 1 from transcription_cleanup_jobs cleanup
        where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
          and cleanup.state <> 'pending'
    ) as cleanup_started,
    exists(select 1 from recording_job_attempt_authorities authority where authority.job_id = jobs.id) as has_attempt_authority,
    (select count(*) from recording_job_failure_history history where history.job_id = jobs.id)::integer as failure_history_count,
    exists(select 1 from recording_transcription_source_renewals renewals where renewals.job_id = jobs.id) as has_renewal
from recording_jobs jobs
join recordings on recordings.id = jobs.recording_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join episodes on episodes.id = jobs.episode_id
join tenants on tenants.id = jobs.tenant_id
where jobs.kind = 'transcription'
  and jobs.state = 'terminal_failure'
  and jobs.error_code = 'recording_source_expired'
  and (sqlc.narg(after_recording_id)::uuid is null or jobs.recording_id > sqlc.narg(after_recording_id)::uuid)
order by jobs.recording_id
limit sqlc.arg(batch_size)::integer;

-- name: GetRecordingTranscriptionRearmCandidate :one
select recordings.id as recording_id, recordings.tenant_id, recordings.episode_id,
    jobs.id as job_id, jobs.state, jobs.error_code, jobs.attempt_count, jobs.fencing_generation,
    jobs.terminal_at, jobs.created_at,
    recording_transcription_source_window_seconds(episodes.config_snapshot)::bigint as source_window_seconds,
    least(
        pipelines.capture_completed_at + (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
        (select min(cleanup.due_at) from transcription_cleanup_jobs cleanup
         where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
           and cleanup.state = 'pending')
    )::timestamptz as capture_retention_expires_at,
    (pipelines.capture_completed_at is not null and exists (
        select 1 from recording_jobs capture
        where capture.recording_id = jobs.recording_id and capture.kind = 'capture' and capture.state = 'succeeded'
    ))::boolean as capture_succeeded,
    (episodes.config_snapshot #>> '{artifact_policy,transcription,mode}')::text as transcription_mode,
    exists(select 1 from recording_transcription_sources source where source.recording_id = jobs.recording_id) as has_transcription_source,
    exists(select 1 from transcriptions transcript where transcript.recording_id = jobs.recording_id) as has_transcript,
    exists(select 1 from recording_data_keys keys where keys.recording_id = jobs.recording_id and keys.capture_epoch = pipelines.capture_epoch) as has_data_key,
    exists(select 1 from recording_presentations presentations where presentations.recording_id = jobs.recording_id) as has_presentation,
    (select count(*) from recording_bundles bundles where bundles.recording_id = jobs.recording_id)::integer as bundle_count,
    array(
        select bundles.object_key from recording_bundles bundles where bundles.recording_id = jobs.recording_id
        union
        select presentations.presentation_object_key from recording_presentations presentations where presentations.recording_id = jobs.recording_id
        union
        select presentations.asset_manifest_object_key from recording_presentations presentations where presentations.recording_id = jobs.recording_id
        union
        select assets.object_key from recording_presentation_assets assets
        join recording_presentations presentations using (presentation_handle)
        where presentations.recording_id = jobs.recording_id
    )::text[] as object_keys,
    exists(
        select 1 from transcription_cleanup_jobs cleanup
        where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
          and cleanup.state <> 'pending'
    ) as cleanup_started,
    exists(select 1 from recording_job_attempt_authorities authority where authority.job_id = jobs.id) as has_attempt_authority,
    (select count(*) from recording_job_failure_history history where history.job_id = jobs.id)::integer as failure_history_count,
    exists(select 1 from recording_transcription_source_renewals renewals where renewals.job_id = jobs.id) as has_renewal
from recording_jobs jobs
join recordings on recordings.id = jobs.recording_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join episodes on episodes.id = jobs.episode_id
join tenants on tenants.id = jobs.tenant_id
where jobs.recording_id = sqlc.arg(recording_id)
  and jobs.kind = 'transcription';

-- name: LockRecordingTranscriptionRearmPipeline :one
select recording_id from recording_pipelines
where recording_id = sqlc.arg(recording_id)
for update;

-- name: LockRecordingTranscriptionRearmJob :one
select jobs.id, jobs.tenant_id, jobs.episode_id, jobs.recording_id, jobs.state,
    jobs.error_code, jobs.attempt_count, jobs.fencing_generation, jobs.terminal_at,
    jobs.created_at,
    recording_transcription_source_window_seconds(episodes.config_snapshot)::bigint as source_window_seconds,
    least(
        pipelines.capture_completed_at + (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
        (select min(cleanup.due_at) from transcription_cleanup_jobs cleanup
         where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
           and cleanup.state = 'pending')
    )::timestamptz as capture_retention_expires_at,
    (pipelines.capture_completed_at is not null and exists (
        select 1 from recording_jobs capture
        where capture.recording_id = jobs.recording_id and capture.kind = 'capture' and capture.state = 'succeeded'
    ))::boolean as capture_succeeded,
    (episodes.config_snapshot #>> '{artifact_policy,transcription,mode}')::text as transcription_mode,
    exists(select 1 from recording_transcription_sources source where source.recording_id = jobs.recording_id) as has_transcription_source,
    exists(select 1 from transcriptions transcript where transcript.recording_id = jobs.recording_id) as has_transcript,
    exists(select 1 from recording_data_keys keys where keys.recording_id = jobs.recording_id and keys.capture_epoch = pipelines.capture_epoch) as has_data_key,
    exists(select 1 from recording_presentations presentations where presentations.recording_id = jobs.recording_id) as has_presentation,
    (select count(*) from recording_bundles bundles where bundles.recording_id = jobs.recording_id)::integer as bundle_count,
    exists(
        select 1 from transcription_cleanup_jobs cleanup
        where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
          and cleanup.state <> 'pending'
    ) as cleanup_started,
    exists(select 1 from recording_job_attempt_authorities authority where authority.job_id = jobs.id) as has_attempt_authority,
    (select count(*) from recording_job_failure_history history where history.job_id = jobs.id)::integer as failure_history_count,
    exists(select 1 from recording_transcription_source_renewals renewals where renewals.job_id = jobs.id) as has_renewal
from recording_jobs jobs
join recordings on recordings.id = jobs.recording_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join episodes on episodes.id = jobs.episode_id
join tenants on tenants.id = jobs.tenant_id
where jobs.recording_id = sqlc.arg(recording_id)
  and jobs.kind = 'transcription'
for update of jobs;

-- name: InsertRecordingTranscriptionSourceRenewal :one
insert into recording_transcription_source_renewals (
    recording_id, job_id, fencing_generation, operator, reason,
    source_expires_at, requested_at
)
select jobs.recording_id, jobs.id, sqlc.arg(fencing_generation), sqlc.arg(operator), sqlc.arg(reason),
    least(
        clock_timestamp() + (recording_transcription_source_window_seconds(episodes.config_snapshot) * interval '1 second'),
        least(
            pipelines.capture_completed_at + (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
            (select min(cleanup.due_at) from transcription_cleanup_jobs cleanup
             where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
               and cleanup.state = 'pending')
        )
    ),
    now()
from recording_jobs jobs
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join episodes on episodes.id = jobs.episode_id
where jobs.id = sqlc.arg(job_id)
  and jobs.recording_id = sqlc.arg(recording_id)
  and least(
      clock_timestamp() + (recording_transcription_source_window_seconds(episodes.config_snapshot) * interval '1 second'),
      least(
            pipelines.capture_completed_at + (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'),
            (select min(cleanup.due_at) from transcription_cleanup_jobs cleanup
             where cleanup.recording_id = jobs.recording_id and cleanup.object_kind = 'recording_source'
               and cleanup.state = 'pending')
        )
  ) > now()
returning *;

-- name: ArchiveRecordingTranscriptionRearmFailure :one
insert into recording_job_failure_history (
    job_id, manual_retry_count, attempt_count, fencing_generation,
    error_code, error_detail, failed_at, retried_at
)
select jobs.id, sqlc.arg(manual_retry_count), jobs.attempt_count, jobs.fencing_generation,
    jobs.error_code, jobs.error_detail, coalesce(jobs.terminal_at, jobs.updated_at), now()
from recording_jobs jobs
where jobs.id = sqlc.arg(job_id)
returning job_id;

-- name: RearmRecordingTranscriptionJob :one
update recording_jobs
set state = 'pending', available_at = now(), lease_token = null,
    lease_owner = null, lease_expires_at = null, error_code = null,
    error_detail = null, terminal_at = null, fencing_generation = sqlc.arg(fencing_generation),
    updated_at = now()
where id = sqlc.arg(job_id)
  and recording_id = sqlc.arg(recording_id)
  and kind = 'transcription'
  and state = 'terminal_failure'
  and error_code = 'recording_source_expired'
returning *;
