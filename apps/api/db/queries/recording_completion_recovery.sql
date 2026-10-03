-- name: LockRecordingCompletionRecovery :one
select recording_id from recording_pipelines
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id)
for update;

-- name: GetRecordingCompletionRecovery :one
select recovery.* from recording_completion_recoveries recovery
join recording_jobs jobs on jobs.id = recovery.job_id
where jobs.tenant_id = sqlc.arg(tenant_id) and jobs.recording_id = sqlc.arg(recording_id);

-- name: GetRecordingCompletionRecoveryCandidate :one
select jobs.id,
    (pipelines.stop_requested_at + recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')::timestamptz as source_expires_at
from recording_jobs jobs
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join episodes on episodes.id = jobs.episode_id
join sync_recordings on sync_recordings.tenant_id = jobs.tenant_id and sync_recordings.recording_id = jobs.recording_id
where jobs.tenant_id = sqlc.arg(tenant_id) and jobs.recording_id = sqlc.arg(recording_id)
  and jobs.kind = 'capture' and jobs.state = 'terminal_failure'
  and pipelines.state = 'terminal_failure' and pipelines.capture_completed_at is null
  and pipelines.capture_ready_at is not null and sync_recordings.status = 'stopped'
  and pipelines.stop_requested_at + recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second' > clock_timestamp()
  and (select count(*) from recording_job_attempt_authorities authority
       where authority.job_id = jobs.id
         and (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean) >= 3
  and exists (select 1 from sync_external_operations operation
      where operation.tenant_id = jobs.tenant_id and operation.episode_id = jobs.episode_id
        and operation.recording_id = jobs.recording_id
        and operation.payload ->> 'stopOperationId' = sync_recordings.stop_external_operation_id::text
        and operation.payload -> 'captureEpoch' = to_jsonb(pipelines.capture_epoch)
        and operation.operation_name = 'recording_capture_stopped' and operation.status = 'applied')
  and exists (select 1 from recording_data_keys where recording_id = jobs.recording_id and capture_epoch = pipelines.capture_epoch)
for update of jobs;

-- name: ListRecordingCompletionRecoveryBundles :many
select object_key, byte_size, checksum from recording_bundles
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id)
order by sequence_number;

-- name: RequestRecordingCompletionRecovery :one
with audit as (
    insert into recording_completion_recoveries (
        job_id, request_id, operator, reason, attempt_count, fencing_generation,
        error_code, error_detail, failed_at, source_expires_at
    )
    select recording_jobs.id, sqlc.arg(request_id), sqlc.arg(operator), sqlc.arg(reason), attempt_count,
        fencing_generation, error_code, error_detail, terminal_at, sqlc.arg(source_expires_at)
    from recording_jobs
    where recording_jobs.id = sqlc.arg(job_id) and state = 'terminal_failure'
      and sqlc.arg(source_expires_at)::timestamptz > clock_timestamp()
    returning job_id
), queued as (
    update recording_jobs set state = 'pending', available_at = now(), updated_at = now()
    where recording_jobs.id in (select job_id from audit)
    returning recording_jobs.recording_id
)
update recording_pipelines set state = 'retryable_failure', updated_at = now()
where recording_pipelines.recording_id in (select queued.recording_id from queued)
returning recording_pipelines.recording_id;
