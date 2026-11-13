-- name: ListRecordingDeferredArtifactStates :many
with selected as (
	select recordings.id, recordings.status as recording_status, recordings.storage_key,
		pipelines.state as pipeline_state, pipelines.capture_completed_at,
		(pipelines.capture_completed_at +
			(recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second'))::timestamptz as source_expires_at,
		case
			when episodes.config_snapshot #>> '{artifact_policy,transcription,mode}' in ('on_demand', 'automatic')
				then episodes.config_snapshot #>> '{artifact_policy,transcription,mode}'
			else 'disabled'
		end::text as transcription_policy,
		artifacts.recording_id is not null as has_artifact,
		artifacts.expires_at as artifact_expires_at,
        coalesce(capture.result_metadata ->> 'capture_stop_reason', '')::text as capture_stop_reason,
        capture.error_code as capture_error_code
    from recordings
    left join recording_pipelines pipelines on pipelines.recording_id = recordings.id
    join episodes on episodes.id = recordings.episode_id
    left join recording_artifacts artifacts on artifacts.recording_id = recordings.id
    left join recording_jobs capture on capture.recording_id = recordings.id and capture.kind = 'capture'
    where recordings.id = any(sqlc.arg(recording_ids)::uuid[])
      and recordings.tenant_id = sqlc.arg(tenant_id)
), export_job as (
    select jobs.recording_id, jobs.id, jobs.state, jobs.error_code
    from recording_jobs jobs
    join selected on selected.id = jobs.recording_id
    where jobs.kind = 'render'
), transcription_job as (
    select jobs.recording_id, jobs.state, jobs.error_code
    from recording_jobs jobs
    join selected on selected.id = jobs.recording_id
    where jobs.kind = 'transcription'
)
select selected.id as recording_id,
    case
        when selected.capture_completed_at is null and (selected.pipeline_state = 'terminal_failure' or selected.recording_status = 'failed') then 'failed'
        when selected.capture_completed_at is null and selected.recording_status = 'completed' then 'expired'
        when selected.capture_completed_at is null then 'pending'
        when selected.source_expires_at <= clock_timestamp() then 'expired'
        else 'available'
	end as source_status,
	selected.source_expires_at,
    selected.capture_stop_reason,
	selected.transcription_policy,
	case
		when selected.transcription_policy = 'disabled' then 'none'
		when transcription_source.status = 'ready' and transcription_source.expires_at > clock_timestamp() then 'ready'
		when transcription_source.expires_at <= clock_timestamp() or transcription_source.status in ('cleanup_pending', 'deleting', 'deleted') then 'expired'
        when transcription_job.error_code in ('recording_source_expired', 'render_deadline_exceeded') then 'expired'
		when selected.capture_completed_at is null and (selected.pipeline_state = 'terminal_failure' or selected.recording_status = 'failed') then 'failed'
		when selected.capture_completed_at is null and selected.recording_status = 'completed' then 'expired'
		when selected.capture_completed_at is null then 'pending'
		when selected.source_expires_at <= clock_timestamp() then 'expired'
		when transcription_job.state = 'terminal_failure' then 'failed'
		when transcription_job.state in ('pending', 'leased', 'retryable_failure') then 'pending'
		else 'none'
	end::text as transcription_preparation_status,
	-- The transcription source has its own window, never longer than the recording source window; a disabled policy has none.
	(case when selected.transcription_policy = 'disabled' then null else transcription_source.expires_at end)::timestamptz as transcription_source_expires_at,
    coalesce(transcription_job.error_code, '')::text as transcription_failure_code,
	export_job.id as export_job_id,
    case
        -- New deferred artifacts carry the capture-anchored expiry; imported
        -- legacy completed MP4s have a null expiry and remain readable.
        when selected.has_artifact and selected.artifact_expires_at is not null and selected.artifact_expires_at <= clock_timestamp() then 'unavailable'
        when selected.has_artifact then 'ready'
        when selected.recording_status = 'completed' and selected.storage_key is not null then 'ready'
        when selected.capture_completed_at is null then 'unavailable'
        when selected.source_expires_at <= clock_timestamp() then 'unavailable'
        when export_job.error_code in ('recording_source_expired', 'render_deadline_exceeded') then 'unavailable'
        when export_job.state in ('pending', 'leased', 'retryable_failure') then 'pending'
        when export_job.state = 'terminal_failure' then 'failed'
        else 'none'
    end as export_status,
    case when export_job.state = 'terminal_failure'
        and coalesce(export_job.error_code, '') not in ('recording_source_expired', 'render_deadline_exceeded')
        and (select count(*) from recording_job_failure_history history where history.job_id = export_job.id) < 5
        and selected.source_expires_at > clock_timestamp() then true else false end as retryable,
    case
        when selected.has_artifact and selected.artifact_expires_at <= clock_timestamp() then 'recording_expired'
        when selected.has_artifact or (selected.recording_status = 'completed' and selected.storage_key is not null) then ''
        when selected.capture_completed_at is null and (selected.pipeline_state = 'terminal_failure' or selected.recording_status = 'failed') then coalesce(selected.capture_error_code, 'capture_failed')
        when selected.capture_completed_at is null then ''
        when selected.source_expires_at <= clock_timestamp() then 'recording_source_expired'
        when export_job.state = 'terminal_failure' then coalesce(export_job.error_code, 'render_failed')
        else ''
    end::text as failure_code,
    case
        when selected.has_artifact and selected.artifact_expires_at <= clock_timestamp() then 'The recording has expired.'
        when selected.has_artifact or (selected.recording_status = 'completed' and selected.storage_key is not null) then ''
        when selected.capture_completed_at is null and (selected.pipeline_state = 'terminal_failure' or selected.recording_status = 'failed') then 'The recording capture did not complete.'
        when selected.capture_completed_at is null then ''
        when selected.source_expires_at <= clock_timestamp() or export_job.error_code = 'recording_source_expired' then 'The recording source expired before rendering completed.'
        when export_job.error_code = 'render_deadline_exceeded' then 'The recording could not be rendered before its deadline.'
        when export_job.state = 'terminal_failure' then 'The recording could not be rendered.'
        else ''
    end::text as failure_message
from selected
left join export_job on export_job.recording_id = selected.id
left join transcription_job on transcription_job.recording_id = selected.id
left join recording_transcription_sources transcription_source on transcription_source.recording_id = selected.id
    and transcription_source.tenant_id = sqlc.arg(tenant_id);

-- name: GetCompletedCaptureRecordingJob :one
select jobs.*
from recording_jobs jobs
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_job_attempt_authorities authority
  on authority.job_id = jobs.id
 and authority.kind = jobs.kind
 and authority.attempt_count = jobs.attempt_count
 and authority.fencing_generation = jobs.fencing_generation
where jobs.id = sqlc.arg(id)
  and jobs.kind = 'capture'
  and jobs.state = 'succeeded'
  and pipelines.capture_completed_at is not null
  and jobs.attempt_count = sqlc.arg(attempt_count)
  and jobs.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner);

-- name: CompleteCaptureRecordingJob :one
with completion_eligibility as materialized (
    select jobs.id,
        recording_capture_completion_available(jobs.recording_id) as completion_available,
        recording_capture_stop_confirmed(jobs.recording_id) as stop_confirmed
    from recording_jobs jobs
    where jobs.id = sqlc.arg(id) and jobs.kind = 'capture'
), completed as (
    update recording_jobs
    set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
        error_code = null, error_detail = null, terminal_at = now(), updated_at = now()
    from completion_eligibility eligibility
    where recording_jobs.id = eligibility.id
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
            and ((convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean is not true
                 or eligibility.completion_available)
            and authority.attempt_count = sqlc.arg(attempt_count)
            and authority.fencing_generation = sqlc.arg(fencing_generation)
            and authority.capture_epoch = sqlc.arg(capture_epoch)
            and authority.envelope_digest = sqlc.arg(envelope_digest)
            and authority.lease_token = sqlc.arg(lease_token)
            and authority.lease_owner = sqlc.arg(lease_owner)
      )
    returning recording_jobs.*
), pipeline as (
    update recording_pipelines
    set state = case when tenants.recording_render_mode = 'automatic' then 'render_queued' else 'capture_complete' end,
        capture_completed_at = now(), updated_at = now()
    from completed
    join tenants on tenants.id = completed.tenant_id
    where recording_pipelines.recording_id = completed.recording_id
    returning recording_pipelines.recording_id, recording_pipelines.reservation_id, recording_pipelines.capture_completed_at
), salvage_event as (
    insert into observability_journey_events (
        event_id, journey_id, sequence, occurred_at, name, phase, state,
        origin_kind, first_observed_layer, upstream_visibility, parent_event_id, trace_id, span_id, attributes
    )
    select gen_random_uuid(), coalesce(start_operation.journey_id, completed.recording_id),
        coalesce((select max(sequence) + 1 from observability_journey_events
                  where journey_id = coalesce(start_operation.journey_id, completed.recording_id)), 0),
        now(), 'recording.capture.salvaged', 'capture_completion', 'succeeded', 'server', 'api', 'visible',
        start_operation.parent_journey_event_id, sqlc.narg(trace_id), sqlc.narg(span_id),
        jsonb_build_object('recording_id', completed.recording_id, 'capture_epoch', sqlc.arg(capture_epoch)::bigint,
                           'reason', 'stop_unconfirmed', 'source', 'committed_bundles')
    from completed
    join completion_eligibility eligibility on eligibility.id = completed.id
    join sync_recordings recording on recording.recording_id = completed.recording_id and recording.tenant_id = completed.tenant_id
    left join sync_external_operations start_operation on start_operation.external_operation_id = recording.start_external_operation_id
        and start_operation.tenant_id = completed.tenant_id and start_operation.episode_id = completed.episode_id
        and start_operation.recording_id = completed.recording_id and start_operation.operation_name = 'start_recording'
    where eligibility.completion_available and not eligibility.stop_confirmed
    returning event_id
), reservation as (
    select recording_pipelines.recording_id, recording_reservations.id,
        recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from pipeline
    join recording_pipelines on recording_pipelines.recording_id = pipeline.recording_id
    join recording_reservations on recording_reservations.id = pipeline.reservation_id
    where recording_reservations.state = 'reserved'
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
), render_job as (
    insert into recording_jobs (
        id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select gen_random_uuid(), completed.tenant_id, completed.episode_id, completed.recording_id,
        'render', 'render:' || completed.recording_id::text,
        sqlc.arg(payload_schema_version), 'pending', sqlc.arg(priority), now(), sqlc.arg(attempt_limit)
    from completed
    join tenants on tenants.id = completed.tenant_id
    where exists (select 1 from reservation_release)
      and tenants.recording_render_mode = 'automatic'
    on conflict (recording_id, kind) do nothing
    returning *
), render_journey as (
    insert into observability_journey_events (
        event_id, journey_id, sequence, occurred_at, name, phase, state,
        origin_kind, first_observed_layer, upstream_visibility, trace_id, span_id, attributes
    )
    select render_job.id, coalesce(sqlc.narg(journey_id)::uuid, render_job.recording_id),
        coalesce((select max(sequence) + 1 from observability_journey_events
                  where journey_id = coalesce(sqlc.narg(journey_id)::uuid, render_job.recording_id)), 0),
        now(), 'recording.render.queued', 'render', 'queued', 'worker', 'api', 'visible',
        sqlc.narg(trace_id)::text, sqlc.narg(span_id)::text,
        jsonb_build_object('tenant_id', render_job.tenant_id, 'episode_id', render_job.episode_id,
            'recording_id', render_job.recording_id, 'capture_job_id', completed.id,
            'render_job_id', render_job.id, 'trigger', 'automatic')
    from render_job join completed on completed.recording_id = render_job.recording_id
), transcription_job as (
    insert into recording_jobs (
        id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select sqlc.arg(render_job_id), completed.tenant_id, completed.episode_id, completed.recording_id, 'transcription',
        'transcription:' || completed.recording_id::text, sqlc.arg(payload_schema_version), 'pending',
        sqlc.arg(priority), now(), sqlc.arg(attempt_limit)
    from completed
    join episodes on episodes.id = completed.episode_id
    where exists (select 1 from reservation_release)
      and sqlc.arg(transcription_enabled)::boolean
      and episodes.config_snapshot -> 'artifact_policy' -> 'transcription' ->> 'mode' in ('automatic', 'on_demand')
    on conflict (recording_id, kind) do nothing
), source_cleanup_objects as (
    select completed.tenant_id, completed.recording_id, allocations.object_key
    from completed
    join recording_bundle_allocations allocations
      on allocations.recording_id = completed.recording_id
     and allocations.state = 'committed'
    union all
    select completed.tenant_id, completed.recording_id, presentations.presentation_object_key
    from completed
    join recording_presentations presentations
      on presentations.recording_id = completed.recording_id
    union all
    select completed.tenant_id, completed.recording_id, presentations.asset_manifest_object_key
    from completed
    join recording_presentations presentations
      on presentations.recording_id = completed.recording_id
    union all
    select completed.tenant_id, completed.recording_id, assets.object_key
    from completed
    join recording_presentations presentations
      on presentations.recording_id = completed.recording_id
    join recording_presentation_assets assets
      on assets.presentation_handle = presentations.presentation_handle
), source_cleanup as (
    insert into transcription_cleanup_jobs (
        id, tenant_id, recording_id, transcript_id, object_key, object_kind, due_at
    )
    select gen_random_uuid(), objects.tenant_id, objects.recording_id, null,
        objects.object_key, 'recording_source', pipeline.capture_completed_at +
            (recording_deferred_retention_seconds(episodes.config_snapshot) * interval '1 second')
    from source_cleanup_objects objects
    join pipeline on pipeline.recording_id = objects.recording_id
    join recordings on recordings.id = objects.recording_id
    join episodes on episodes.id = recordings.episode_id
    on conflict (recording_id, object_key) do update set
        due_at = least(transcription_cleanup_jobs.due_at, excluded.due_at),
        updated_at = now()
)
-- Read pipeline's RETURNING row so publication follows its completion update.
-- The obligation commits with media and lease release, even if its immediate outbox insert fails.
select completed.*
from completed
join pipeline on pipeline.recording_id = completed.recording_id
where recording_publish_completed_capture_stop(pipeline.recording_id, sqlc.narg(trace_id)::text, sqlc.narg(span_id)::text);
