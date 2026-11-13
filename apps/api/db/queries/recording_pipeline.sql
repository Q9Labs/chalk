-- name: GetRecordingPipeline :one
select recording_id, tenant_id, reservation_id, capture_epoch, state, stop_operation_id, stop_requested_at,
    capture_completed_at, committed_at, updated_at, created_at
from recording_pipelines
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id);

-- name: GetRecordingPipelineStopAuthority :one
select recording_pipelines.recording_id, recording_pipelines.tenant_id,
    recording_pipelines.reservation_id, recording_pipelines.capture_epoch, recording_pipelines.state,
    recording_pipelines.stop_operation_id, recording_pipelines.stop_requested_at,
    recording_pipelines.capture_completed_at, recording_pipelines.committed_at,
    recording_pipelines.updated_at, recording_pipelines.created_at
from recording_pipelines
join recordings on recordings.id = recording_pipelines.recording_id
where recording_pipelines.tenant_id = sqlc.arg(tenant_id)
  and recording_pipelines.recording_id = sqlc.arg(recording_id)
  and recordings.episode_id = sqlc.arg(episode_id);

-- name: RequestRecordingStop :one
update recording_pipelines
set stop_operation_id = coalesce(recording_pipelines.stop_operation_id, sqlc.arg(stop_operation_id)),
    stop_requested_at = coalesce(recording_pipelines.stop_requested_at, now()),
    updated_at = now()
where recording_pipelines.tenant_id = sqlc.arg(tenant_id)
  and recording_pipelines.recording_id = sqlc.arg(recording_id)
  and exists (
      select 1 from recordings
      where recordings.id = recording_pipelines.recording_id
        and recordings.tenant_id = sqlc.arg(tenant_id)
        and recordings.episode_id = sqlc.arg(episode_id)
  )
  and (
      recording_pipelines.stop_operation_id = sqlc.arg(stop_operation_id)
      or (
          recording_pipelines.stop_operation_id is not null
          and recording_pipelines.stop_requested_at is not null
          and exists (
              select 1 from sync_external_operations operation
              join recordings recording on recording.id = recording_pipelines.recording_id
              where operation.tenant_id = recording_pipelines.tenant_id
                and operation.space_id = recording.space_id
                and operation.episode_id = recording.episode_id
                and operation.recording_id = recording.id
                and operation.external_operation_id = sqlc.arg(stop_operation_id)
                and operation.operation_name in ('end_episode', 'tenant_end_episode', 'maximum_episode_duration_expired')
                and operation.status = 'pending'
          )
      )
      or (
          recording_pipelines.stop_operation_id is null
          and recording_pipelines.state in ('reserved', 'capture_leased', 'capturing_segmented', 'capture_complete', 'render_queued', 'rendering', 'verifying', 'retryable_failure', 'committed', 'terminal_failure', 'deleted')
      )
  )
returning recording_id, tenant_id, reservation_id, capture_epoch, state, stop_operation_id, stop_requested_at,
    capture_completed_at, committed_at, updated_at, created_at;

-- name: LockRecordingJobClaimRequest :exec
select pg_advisory_xact_lock(hashtextextended(sqlc.arg(claim_request_id)::text, 0));

-- name: GetRecordingCaptureCompletionIdentity :one
select recording_id from recording_jobs where id = sqlc.arg(job_id) and kind = 'capture';

-- name: ClaimRecordingJob :one
with claimant as (
    select sfu_node from recording_colocated_capture_workers
    where worker_id::text = sqlc.arg(lease_owner)::text
), candidate as (
    select recording_jobs.id, recovery.source_expires_at as recovery_expires_at,
        (recording_jobs.kind = 'capture' and recording_capture_completion_available(recording_jobs.recording_id))::boolean as completion_only,
        recording_pipelines.capture_completed_at +
            ((case when recording_jobs.kind = 'transcription'
                then recording_transcription_source_window_seconds(episodes.config_snapshot)
                else recording_deferred_retention_seconds(episodes.config_snapshot)
            end) * interval '1 second') as source_expires_at
    from recording_jobs
    join recording_pipelines on recording_pipelines.recording_id = recording_jobs.recording_id
    join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
    join episodes on episodes.id = recording_jobs.episode_id
    left join recording_completion_recoveries recovery
      on recovery.job_id = recording_jobs.id
     and recovery.fencing_generation = recording_jobs.fencing_generation
     and recovery.source_expires_at > clock_timestamp()
     and exists (select 1 from recording_bundles where recording_id = recording_jobs.recording_id)
     and exists (select 1 from recording_data_keys where recording_id = recording_jobs.recording_id
                 and capture_epoch = recording_pipelines.capture_epoch)
    cross join lateral (
        select case when recording_jobs.kind = 'capture' then recording_capture_completion_attempts(recording_jobs.id) else 0 end as attempts
    ) completion
    where (
        recording_jobs.kind = sqlc.arg(kind)
        or (sqlc.arg(kind) = 'render' and recording_jobs.kind = 'transcription')
      )
      and recording_jobs.state = 'pending'
      and (recording_jobs.kind <> 'transcription' or sqlc.arg(transcription_enabled)::boolean)
      and (recording_jobs.kind not in ('render', 'transcription') or
          recording_pipelines.capture_completed_at +
              ((case when recording_jobs.kind = 'transcription'
                  then recording_transcription_source_window_seconds(episodes.config_snapshot)
                  else recording_deferred_retention_seconds(episodes.config_snapshot)
              end) * interval '1 second') > clock_timestamp())
      and (recording_jobs.kind not in ('render', 'transcription') or
          coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = recording_jobs.id), recording_jobs.created_at) + sqlc.arg(maximum_render_seconds)::integer * interval '1 second' > clock_timestamp())
      and recording_jobs.available_at <= now()
      -- A colocated worker takes only the captures of its own node. Everyone else leaves a capture
      -- to the colocated worker for the grace while that worker is healthy.
      and (recording_jobs.kind <> 'capture' or case
          when exists (select 1 from claimant)
              then sqlc.arg(colocated_grace_seconds)::integer > 0
                  and episodes.config_snapshot->'media_plane_binding'->>'provider' = 'chalk_sfu'
                  and episodes.config_snapshot->'media_plane_binding'->>'node' = (select sfu_node from claimant)
                  and not recording_capture_colocated_attempted(recording_jobs.id)
          else not (sqlc.arg(colocated_grace_seconds)::integer > 0
                  and recording_capture_colocated(recording_jobs.recording_id, sqlc.arg(colocated_grace_seconds)::integer))
          end)
      and (recording_jobs.kind <> 'capture' or recording_pipelines.stop_requested_at is null or sqlc.arg(supports_completion_only)::boolean)
      and (recording_jobs.kind <> 'capture' or recording_pipelines.stop_requested_at is null or (completion.attempts < 3 or recovery.job_id is not null))
      and (recording_jobs.attempt_count < recording_jobs.attempt_limit or
          (recording_jobs.kind = 'capture' and (completion.attempts < 3 or recovery.job_id is not null) and
           recording_capture_completion_available(recording_jobs.recording_id)))
      and (recording_jobs.kind <> 'capture' or recording_pipelines.stop_operation_id is null or
          ((completion.attempts < 3 or recovery.job_id is not null) and recording_capture_completion_available(recording_jobs.recording_id)))
      and (recording_jobs.kind <> 'capture' or
          (recording_reservations.state = 'reserved' and recording_reservations.ends_at > now()) or
          ((completion.attempts < 3 or recovery.job_id is not null) and recording_capture_completion_available(recording_jobs.recording_id)))
      and ((recording_jobs.kind = 'capture' and recording_pipelines.state in ('reserved', 'retryable_failure'))
        or (recording_jobs.kind = 'transcription' and recording_pipelines.capture_completed_at is not null
            and recording_pipelines.state <> 'deleted')
        or (recording_jobs.kind = 'render' and recording_pipelines.state in ('render_queued', 'retryable_failure')))
    order by recording_jobs.priority desc, recording_jobs.available_at, recording_jobs.id
    for update of recording_jobs, recording_pipelines skip locked
    limit 1
), leased as (
    update recording_jobs
    set state = 'leased',
        attempt_count = attempt_count + 1,
        lease_token = sqlc.arg(lease_token),
        lease_owner = sqlc.arg(lease_owner),
		lease_expires_at = case when recording_jobs.kind in ('render', 'transcription')
			then least(sqlc.arg(lease_expires_at)::timestamptz, candidate.source_expires_at,
				coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = recording_jobs.id), recording_jobs.created_at) + sqlc.arg(maximum_render_seconds)::integer * interval '1 second')
            when candidate.completion_only then least(sqlc.arg(lease_expires_at)::timestamptz,
                candidate.recovery_expires_at, recording_capture_salvage_deadline(recording_jobs.recording_id))
            else least(sqlc.arg(lease_expires_at)::timestamptz, candidate.recovery_expires_at) end,
        fencing_generation = fencing_generation + 1,
        updated_at = now()
    from candidate
    where recording_jobs.id = candidate.id
    returning recording_jobs.id, recording_jobs.tenant_id, recording_jobs.episode_id,
        recording_jobs.recording_id, recording_jobs.kind, recording_jobs.idempotency_key,
        recording_jobs.payload_schema_version, recording_jobs.state, recording_jobs.priority,
        recording_jobs.available_at, recording_jobs.attempt_count, recording_jobs.attempt_limit,
        recording_jobs.lease_token, recording_jobs.lease_owner, recording_jobs.lease_expires_at,
        recording_jobs.fencing_generation, recording_jobs.error_code, recording_jobs.error_detail,
        recording_jobs.terminal_at, recording_jobs.updated_at, recording_jobs.created_at,
        candidate.completion_only
), pipeline as (
    update recording_pipelines
    set state = case
            when leased.kind = 'capture' then 'capture_leased'
            when leased.kind = 'render' then 'rendering'
            else recording_pipelines.state
        end,
        capture_epoch = case when leased.kind = 'capture' and not leased.completion_only then capture_epoch + 1 else capture_epoch end,
        updated_at = now()
    from leased
    where recording_pipelines.recording_id = leased.recording_id
      and (leased.kind <> 'capture' or leased.completion_only or recording_pipelines.stop_operation_id is null)
      and ((leased.kind = 'capture' and recording_pipelines.state in ('reserved', 'retryable_failure'))
        or (leased.kind = 'transcription' and recording_pipelines.capture_completed_at is not null
            and recording_pipelines.state <> 'deleted')
        or (leased.kind = 'render' and recording_pipelines.state in ('render_queued', 'retryable_failure')))
    returning recording_pipelines.recording_id, recording_pipelines.capture_epoch
)
select leased.id, leased.tenant_id, leased.episode_id, leased.recording_id, leased.kind,
    leased.idempotency_key, leased.payload_schema_version, leased.state, leased.priority,
    leased.available_at, leased.attempt_count, leased.attempt_limit, leased.lease_token,
    leased.lease_owner, leased.lease_expires_at, leased.fencing_generation, leased.error_code,
    leased.error_detail, leased.terminal_at, leased.updated_at, leased.created_at,
    coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = leased.id), leased.created_at)::timestamptz as execution_started_at,
    pipeline.capture_epoch, leased.completion_only, recording_reservations.space_id,
    recording_reservations.policy_snapshot_version, recording_reservations.ends_at,
    recording_pipelines.capture_completed_at, recording_pipelines.capture_ready_at,
	recording_presentations.presentation_handle,
	recording_presentations.schema_version as presentation_schema_version,
	recording_presentations.profile_version as presentation_profile_version,
	recording_presentations.presentation_sha256,
	recording_presentations.duration_millis as presentation_duration_millis,
	recording_data_keys.key_handle as capture_key_handle
from leased
join pipeline on pipeline.recording_id = leased.recording_id
join recording_pipelines on recording_pipelines.recording_id = leased.recording_id
join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
left join recording_presentations
  on recording_presentations.tenant_id = leased.tenant_id
 and recording_presentations.recording_id = leased.recording_id
 and recording_presentations.capture_epoch = pipeline.capture_epoch
left join recording_data_keys
  on recording_data_keys.tenant_id = leased.tenant_id
 and recording_data_keys.recording_id = leased.recording_id
 and recording_data_keys.capture_epoch = pipeline.capture_epoch
where leased.kind not in ('render', 'transcription')
   or (
	   recording_presentations.presentation_handle is not null
	   and recording_data_keys.key_handle is not null
	   and recording_pipelines.capture_ready_at is not null
	);
