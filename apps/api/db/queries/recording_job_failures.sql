-- name: FailRecordingJob :one
with failure_policy as (
    select jobs.id,
        (jobs.kind = 'capture' and ((sqlc.narg(error_code)::text in ('capture_completion_failed', 'capture_stop_publication_failed')
         and pipelines.stop_requested_at is not null)
         or recording_capture_completion_available(jobs.recording_id)))::boolean as completion_failure,
        case when jobs.kind = 'capture' then recording_capture_completion_attempts(jobs.id) else 0 end as completion_attempts
    from recording_jobs jobs
    left join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
    where jobs.id = sqlc.arg(id)
), failed as (
    update recording_jobs
    set state = case when failure_policy.completion_failure then
            case when failure_policy.completion_attempts >= 3 and sqlc.narg(error_code)::text is distinct from 'capture_stop_publication_failed' then 'terminal_failure' else 'pending' end
        when attempt_count >= attempt_limit then 'terminal_failure' else 'pending' end,
        available_at = sqlc.arg(available_at),
        lease_token = null, lease_owner = null, lease_expires_at = null,
        error_code = sqlc.arg(error_code), error_detail = sqlc.arg(error_detail),
        terminal_at = case when failure_policy.completion_failure then
            case when failure_policy.completion_attempts >= 3 and sqlc.narg(error_code)::text is distinct from 'capture_stop_publication_failed' then now() else null end
            when attempt_count >= attempt_limit then now() else null end,
        updated_at = now()
    from failure_policy
    where recording_jobs.id = failure_policy.id
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
    returning recording_jobs.*
), attempt_failure as (
    -- The job row keeps only its latest error and clears it on success; this row outlives a retry.
    insert into recording_job_attempt_failures (
        job_id, attempt_count, fencing_generation, kind, error_code, error_detail, lease_owner
    )
    select failed.id, failed.attempt_count, failed.fencing_generation, failed.kind,
        sqlc.arg(error_code), sqlc.arg(error_detail), sqlc.arg(lease_owner)
    from failed
    on conflict do nothing
), publication_failure as (
    insert into recording_capture_publication_failures(job_id, attempt_count, fencing_generation)
    select id, attempt_count, fencing_generation from failed
    where kind = 'capture' and sqlc.narg(error_code)::text = 'capture_stop_publication_failed'
    on conflict do nothing
), pipeline as (
    update recording_pipelines
    set state = case
            when (select kind from failed) = 'transcription' then recording_pipelines.state
            when (select state from failed) = 'terminal_failure' then 'terminal_failure'
            else 'retryable_failure'
        end,
        updated_at = now()
    from failed
    where recording_pipelines.recording_id = failed.recording_id
    returning recording_pipelines.recording_id, (select state from failed) as job_state
), failed_transcription_allocation_cleanup as (
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), allocations.tenant_id, allocations.recording_id, null,
        allocations.object_key, 'recording_source', now()
    from recording_render_object_allocations allocations
    join failed on failed.id = allocations.render_job_id
        and failed.attempt_count = allocations.attempt_count
        and failed.fencing_generation = allocations.fencing_generation
    where failed.kind = 'transcription'
      and allocations.purpose in ('transcription_manifest', 'transcription_audio')
      and allocations.state in ('allocated', 'committed')
      and not exists (
          select 1
          from recording_transcription_sources source
          where source.recording_id = allocations.recording_id
            and (
                source.manifest_allocation_id = allocations.id
                or exists (
                    select 1
                    from recording_transcription_source_chunks chunks
                    where chunks.recording_id = source.recording_id
                      and chunks.allocation_id = allocations.id
                )
            )
      )
    on conflict (recording_id, object_key) do nothing
    returning id
), reservation as (
    select recording_reservations.id, recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from pipeline
    join recording_pipelines on recording_pipelines.recording_id = pipeline.recording_id
    join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
    where pipeline.job_state = 'terminal_failure'
      and recording_reservations.state = 'reserved'
), capacity_release as (
    update recording_capacity
    set reserved_episodes = reserved_episodes - (select count(*) from reservation),
        reserved_participants = reserved_participants - coalesce((select sum(participant_count) from reservation), 0),
        reserved_input_bitrate_bps = reserved_input_bitrate_bps - coalesce((select sum(input_bitrate_bps) from reservation), 0),
        updated_at = now()
    where id = 1 and exists (select 1 from reservation)
    returning id
), reservation_release as (
    update recording_reservations
    set state = 'released', updated_at = now()
    where id in (select id from reservation)
      and exists (select 1 from capacity_release)
    returning id
)
select failed.id, failed.tenant_id, failed.episode_id, failed.recording_id, failed.kind, failed.idempotency_key,
    failed.payload_schema_version, failed.state, failed.priority, failed.available_at, failed.attempt_count,
    failed.attempt_limit, failed.lease_token, failed.lease_owner, failed.lease_expires_at, failed.fencing_generation,
    failed.error_code, failed.error_detail, failed.terminal_at, failed.updated_at, failed.created_at
from failed cross join (select count(*) from reservation_release) released;

-- name: RelinquishCaptureRecordingJob :one
with locked as (
    select jobs.id
    from recording_jobs jobs
    join recording_pipelines pipeline on pipeline.recording_id = jobs.recording_id
    where jobs.id = sqlc.arg(id)
      and jobs.kind = 'capture'
      and jobs.state = 'leased'
      and jobs.attempt_count = sqlc.arg(attempt_count)
      and jobs.fencing_generation = sqlc.arg(fencing_generation)
      and jobs.lease_token = sqlc.arg(lease_token)
      and jobs.lease_owner = sqlc.arg(lease_owner)
      and jobs.lease_expires_at > now()
      and pipeline.stop_operation_id is null
      and pipeline.state in ('capture_leased', 'capturing_segmented')
      and exists (
          select 1 from recording_job_attempt_authorities authority
          where authority.job_id = jobs.id
            and authority.kind = 'capture'
            and authority.attempt_count = sqlc.arg(attempt_count)
            and authority.fencing_generation = sqlc.arg(fencing_generation)
            and authority.capture_epoch = sqlc.arg(capture_epoch)
            and authority.envelope_digest = sqlc.arg(envelope_digest)
            and authority.lease_token = sqlc.arg(lease_token)
            and authority.lease_owner = sqlc.arg(lease_owner)
      )
    for update of jobs, pipeline
), relinquished as (
    update recording_jobs
    set state = 'pending',
        available_at = now(),
        attempt_count = attempt_count - 1,
        lease_token = null,
        lease_owner = null,
        lease_expires_at = null,
        updated_at = now()
    from locked
    where recording_jobs.id = locked.id
    returning recording_jobs.id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_count,
        attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
        error_code, error_detail, terminal_at, updated_at, created_at, result_metadata
), pipeline as (
    update recording_pipelines
    set state = 'retryable_failure', updated_at = now()
    from relinquished
    where recording_pipelines.recording_id = relinquished.recording_id
    returning recording_pipelines.recording_id
), result as (
    select relinquished.*
    from relinquished
    join pipeline on pipeline.recording_id = relinquished.recording_id
    union all
    select jobs.*
    from recording_jobs jobs
    join recording_pipelines current_pipeline on current_pipeline.recording_id = jobs.recording_id
    where jobs.id = sqlc.arg(id)
      and jobs.kind = 'capture'
      and jobs.state = 'pending'
      and jobs.attempt_count = sqlc.arg(attempt_count) - 1
      and jobs.fencing_generation = sqlc.arg(fencing_generation)
      and jobs.lease_token is null
      and jobs.lease_owner is null
      and jobs.lease_expires_at is null
      and current_pipeline.state = 'retryable_failure'
      and current_pipeline.stop_operation_id is null
      and not exists (select 1 from relinquished)
      and exists (
          select 1 from recording_job_attempt_authorities authority
          where authority.job_id = jobs.id
            and authority.kind = 'capture'
            and authority.attempt_count = sqlc.arg(attempt_count)
            and authority.fencing_generation = sqlc.arg(fencing_generation)
            and authority.capture_epoch = sqlc.arg(capture_epoch)
            and authority.envelope_digest = sqlc.arg(envelope_digest)
            and authority.lease_token = sqlc.arg(lease_token)
            and authority.lease_owner = sqlc.arg(lease_owner)
      )
)
select id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at, result_metadata
from result;
