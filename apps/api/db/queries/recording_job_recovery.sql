-- name: RecoverExpiredRecordingJobs :many
with completed_captures as materialized (
    -- Capture completion is durable even if the worker lost its stopped callback.
    -- Epoch zero predates recorder authority and needs explicit repair.
    -- Keep it alerting without letting it poison ordinary worker recovery.
    select pipelines.recording_id, pipelines.stop_operation_id, pipelines.capture_epoch
    from recording_pipelines pipelines
    join sync_recordings recording on recording.tenant_id = pipelines.tenant_id
        and recording.recording_id = pipelines.recording_id
    join sync_external_operations source on source.tenant_id = recording.tenant_id
        and source.space_id = recording.space_id and source.episode_id = recording.episode_id
        and source.recording_id = recording.recording_id
        and source.external_operation_id = pipelines.stop_operation_id
        and source.operation_name = 'stop_recording' and source.status = 'applied'
    where pipelines.capture_completed_at is not null
      and pipelines.capture_epoch > 0
      and recording.status = 'stopping'
      and not exists (select 1 from recording_capture_stop_publications publication where publication.recording_id = pipelines.recording_id)
      and recording.stop_external_operation_id = pipelines.stop_operation_id
      and not exists (
          select 1 from sync_external_operations operation
          where operation.tenant_id = recording.tenant_id
            and operation.episode_id = recording.episode_id
            and operation.operation_name = 'recording_capture_stopped'
            and operation.recording_id = recording.recording_id
            and operation.status in ('pending', 'applied')
            and operation.payload ->> 'stopOperationId' = pipelines.stop_operation_id::text
            and operation.payload ->> 'captureEpoch' = pipelines.capture_epoch::text
      )
    order by pipelines.capture_completed_at, pipelines.recording_id
    limit 100
    -- Fence parent deletion through the insert, without waiting on a busy row.
    for key share of pipelines skip locked
), recovered_capture_stops as (
    insert into recording_capture_stop_publications(recording_id, stop_operation_id, capture_epoch)
    select recording_id, stop_operation_id, capture_epoch
    from completed_captures
    on conflict (recording_id) do nothing
), expired as (
    select jobs.id, jobs.state as prior_state, ((jobs.kind in ('render', 'transcription') and
        pipelines.capture_completed_at +
            ((case when jobs.kind = 'transcription'
                then recording_transcription_source_window_seconds(episodes.config_snapshot)
                else recording_deferred_retention_seconds(episodes.config_snapshot)
            end) * interval '1 second') <= clock_timestamp())
        or (jobs.kind = 'capture' and pipelines.capture_ready_at is not null
            and recording_capture_salvage_deadline(jobs.recording_id) <= clock_timestamp())
        or exists (select 1 from recording_completion_recoveries recovery
                   where recovery.job_id = jobs.id and recovery.source_expires_at <= clock_timestamp())) as source_expired,
        jobs.kind in ('render', 'transcription') and
            coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = jobs.id), jobs.created_at) + sqlc.arg(maximum_render_seconds)::integer * interval '1 second' <= clock_timestamp() as execution_deadline_reached,
        (jobs.kind = 'capture' and pipelines.stop_requested_at is not null)::boolean as capture_stopped,
        (jobs.kind = 'capture' and recording_capture_completion_available(jobs.recording_id))::boolean as completion_only,
        case when jobs.kind = 'capture' then recording_capture_completion_attempts(jobs.id) else 0 end as completion_attempts
    from recording_jobs jobs
    join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
    join episodes on episodes.id = jobs.episode_id
    where (jobs.state = 'leased' and jobs.lease_expires_at <= clock_timestamp())
       or (jobs.kind in ('render', 'transcription') and jobs.state in ('pending', 'leased') and
           pipelines.capture_completed_at +
               ((case when jobs.kind = 'transcription'
                   then recording_transcription_source_window_seconds(episodes.config_snapshot)
                   else recording_deferred_retention_seconds(episodes.config_snapshot)
               end) * interval '1 second') <= clock_timestamp())
       or (jobs.kind in ('render', 'transcription') and jobs.state in ('pending', 'leased') and
           coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = jobs.id), jobs.created_at) + sqlc.arg(maximum_render_seconds)::integer * interval '1 second' <= clock_timestamp())
       or (jobs.kind = 'capture' and jobs.state = 'pending' and pipelines.stop_requested_at is not null
           and not exists (
               select 1 from recording_completion_recoveries recovery
               where recovery.job_id = jobs.id and recovery.fencing_generation = jobs.fencing_generation
                 and recovery.source_expires_at > clock_timestamp()
                 and exists (select 1 from recording_bundles where recording_id = jobs.recording_id)
                 and exists (select 1 from recording_data_keys where recording_id = jobs.recording_id
                             and capture_epoch = pipelines.capture_epoch)
           ))
    for update of jobs skip locked
), recovered as (
    update recording_jobs
    set state = case when (attempt_count >= attempt_limit and not expired.completion_only) or expired.source_expired or expired.execution_deadline_reached or
            (expired.capture_stopped and (not expired.completion_only or expired.completion_attempts >= 3)) then 'terminal_failure' else 'pending' end,
        available_at = now(), lease_token = null, lease_owner = null, lease_expires_at = null,
        terminal_at = case when (attempt_count >= attempt_limit and not expired.completion_only) or expired.source_expired or expired.execution_deadline_reached or
            (expired.capture_stopped and (not expired.completion_only or expired.completion_attempts >= 3)) then now() else null end,
        error_code = case when expired.source_expired then 'recording_source_expired' when expired.execution_deadline_reached then 'render_deadline_exceeded'
            when expired.completion_only and expired.prior_state = 'leased' then 'capture_completion_expired'
            when expired.completion_only then coalesce(error_code, 'capture_completion_expired')
            when expired.capture_stopped then 'capture_stopped_before_completion' else coalesce(error_code, 'lease_expired') end,
        error_detail = case when expired.completion_only and expired.prior_state = 'leased' then 'stage=post_stop outcome=lease_expired error_class=unknown'
            when expired.completion_only then coalesce(error_detail, 'stage=post_stop outcome=unreported error_class=unknown')
            when expired.capture_stopped then coalesce(error_detail, case when attempt_count = 0 and not exists (
                select 1 from recording_job_attempt_authorities authority where authority.job_id = recording_jobs.id
            ) then 'stage=capture_start outcome=stopped_before_claim error_class=none'
            else 'stage=capture_stop outcome=unconfirmed error_class=unknown' end) else error_detail end,
        updated_at = now()
    from expired
    where recording_jobs.id = expired.id
    returning recording_jobs.id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_count,
        attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
        error_code, error_detail, terminal_at, updated_at, created_at, result_metadata
), pipeline as (
    update recording_pipelines
    set state = case when recovered.state = 'terminal_failure' then 'terminal_failure' else 'retryable_failure' end,
        updated_at = now()
    from recovered
    where recording_pipelines.recording_id = recovered.recording_id
      and recovered.kind <> 'transcription'
    returning recording_pipelines.recording_id, recovered.state as job_state
), recovered_transcription_allocation_cleanup as (
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), allocations.tenant_id, allocations.recording_id, null,
        allocations.object_key, 'recording_source', now()
    from recording_render_object_allocations allocations
    join recovered on recovered.id = allocations.render_job_id
        and recovered.attempt_count = allocations.attempt_count
        and recovered.fencing_generation = allocations.fencing_generation
    where recovered.kind = 'transcription'
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
    where pipeline.job_state = 'terminal_failure' and recording_reservations.state = 'reserved'
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
select recovered.id, recovered.tenant_id, recovered.episode_id, recovered.recording_id, recovered.kind,
    recovered.idempotency_key, recovered.payload_schema_version, recovered.state, recovered.priority,
    recovered.available_at, recovered.attempt_count, recovered.attempt_limit, recovered.lease_token,
    recovered.lease_owner, recovered.lease_expires_at, recovered.fencing_generation, recovered.error_code,
    recovered.error_detail, recovered.terminal_at, recovered.updated_at, recovered.created_at
from recovered cross join (select count(*) from reservation_release) released;

-- name: ListRecordingDeadLetters :many
select id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at, result_metadata
from recording_jobs
where tenant_id = sqlc.arg(tenant_id) and state = 'terminal_failure'
order by terminal_at desc, id desc
limit sqlc.arg(limit_count)::integer;

-- name: ExpireRecordingReservations :many
with expired_preparations as (
    update recording_preparations
    set state = 'expired', revision = revision + 1, updated_at = sqlc.arg(now)::timestamptz
    where state = 'scheduled' and starts_at <= sqlc.arg(now)::timestamptz - interval '5 minutes'
), expired as (
    select recording_reservations.id, recording_reservations.recording_id,
        recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from recording_reservations
    join recording_pipelines on recording_pipelines.recording_id = recording_reservations.recording_id
    join recording_jobs on recording_jobs.recording_id = recording_reservations.recording_id
        and recording_jobs.kind = 'capture'
    where recording_reservations.state = 'reserved'
      and coalesce(recording_reservations.starts_at, recording_reservations.created_at) + interval '10 minutes' <= sqlc.arg(now)
      and recording_pipelines.state = 'reserved'
      and recording_jobs.state = 'pending'
      and recording_jobs.attempt_count = 0
    for update of recording_reservations, recording_jobs skip locked
), capacity_update as (
    update recording_capacity
    set reserved_episodes = reserved_episodes - (select count(*) from expired),
        reserved_participants = reserved_participants - coalesce((select sum(participant_count) from expired), 0),
        reserved_input_bitrate_bps = reserved_input_bitrate_bps - coalesce((select sum(input_bitrate_bps) from expired), 0),
        updated_at = now()
    where id = 1 and exists (select 1 from expired)
    returning id
), reservations as (
    update recording_reservations
    set state = 'expired', updated_at = now()
    where id in (select id from expired)
    returning id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
), jobs as (
    update recording_jobs
    set state = 'terminal_failure', lease_token = null, lease_owner = null, lease_expires_at = null,
        error_code = 'capture_reservation_expired', terminal_at = now(), updated_at = now()
    from reservations
    where recording_jobs.recording_id = reservations.recording_id
      and recording_jobs.kind = 'capture'
      and recording_jobs.state = 'pending'
      and recording_jobs.attempt_count = 0
    returning recording_jobs.recording_id
), pipelines as (
    update recording_pipelines
    set state = 'terminal_failure', updated_at = now()
    from reservations
    join jobs on jobs.recording_id = reservations.recording_id
    cross join capacity_update
    where recording_pipelines.recording_id = reservations.recording_id
      and recording_pipelines.state in ('requested', 'reserved', 'retryable_failure')
    returning recording_pipelines.recording_id
), failure_candidates as (
    select reservations.tenant_id, reservations.space_id, reservations.episode_id,
        reservations.recording_id, start_operations.external_operation_id as start_operation_id
    from reservations
    join pipelines on pipelines.recording_id = reservations.recording_id
    join sync_recordings
      on sync_recordings.tenant_id = reservations.tenant_id
     and sync_recordings.space_id = reservations.space_id
     and sync_recordings.episode_id = reservations.episode_id
     and sync_recordings.recording_id = reservations.recording_id
     and sync_recordings.status = 'starting'
    join sync_external_operations start_operations
      on start_operations.tenant_id = sync_recordings.tenant_id
     and start_operations.space_id = sync_recordings.space_id
     and start_operations.episode_id = sync_recordings.episode_id
     and start_operations.external_operation_id = sync_recordings.start_external_operation_id
     and start_operations.operation_name = 'start_recording'
     and start_operations.recording_id = reservations.recording_id
     and start_operations.external_operation_id::text = reservations.idempotency_key
), failure_operations as (
    insert into sync_external_operations (
        tenant_id, space_id, episode_id, external_operation_id, request_key,
        request_fingerprint, operation_name, recording_id, payload, fence_active
    )
    select tenant_id, space_id, episode_id, gen_random_uuid(),
        'capture_expired_' || replace(recording_id::text, '-', ''),
        sha256(convert_to(
            'recording_capture_failed:' || recording_id::text || ':' ||
            start_operation_id::text || ':capture_reservation_expired',
            'UTF8'
        )),
        'recording_capture_failed', recording_id,
        jsonb_build_object(
            'recordingId', recording_id::text,
            'startOperationId', start_operation_id::text,
            'failureCode', 'capture_reservation_expired'
        ),
        false
    from failure_candidates
    on conflict (tenant_id, episode_id, operation_name, request_key) do nothing
    returning recording_id
)
select reservations.id, reservations.tenant_id, reservations.space_id, reservations.episode_id,
    reservations.recording_id, reservations.idempotency_key, reservations.policy_snapshot_version, reservations.participant_count,
    reservations.max_duration_seconds, reservations.input_bitrate_bps, reservations.state,
    reservations.starts_at, reservations.ends_at, reservations.updated_at, reservations.created_at
from reservations
join pipelines on pipelines.recording_id = reservations.recording_id
cross join (select count(*) from failure_operations) projected_failures;
