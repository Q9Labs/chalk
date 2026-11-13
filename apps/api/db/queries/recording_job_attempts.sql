-- name: GetRecordingJobAttemptAuthorityByClaimRequest :one
select authority.job_id, authority.attempt_count, authority.fencing_generation,
    authority.capture_epoch, authority.claim_request_id, authority.kind,
    authority.lease_owner, authority.lease_token, authority.lease_expires_at,
    authority.envelope_bytes, authority.envelope_digest, authority.issued_at,
    jobs.tenant_id, jobs.episode_id, jobs.recording_id, jobs.idempotency_key,
    jobs.payload_schema_version, jobs.state, jobs.priority, jobs.available_at,
    jobs.attempt_limit, jobs.error_code, jobs.error_detail, jobs.terminal_at,
    jobs.updated_at, jobs.created_at,
    coalesce((select max(history.retried_at) from recording_job_failure_history history where history.job_id = jobs.id and history.fencing_generation < authority.fencing_generation), jobs.created_at)::timestamptz as execution_started_at, reservations.space_id,
    reservations.policy_snapshot_version, reservations.ends_at, pipelines.capture_completed_at
from recording_job_attempt_authorities authority
join recording_jobs jobs on jobs.id = authority.job_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_reservations reservations on reservations.id = pipelines.reservation_id
where authority.claim_request_id = sqlc.arg(claim_request_id)
  and authority.kind = jobs.kind;

-- name: InsertRecordingJobAttemptAuthority :one
insert into recording_job_attempt_authorities (
    job_id, attempt_count, fencing_generation, capture_epoch, claim_request_id,
    kind, lease_owner, lease_token, lease_expires_at, envelope_bytes,
    envelope_digest, issued_at
)
values (
    sqlc.arg(job_id), sqlc.arg(attempt_count), sqlc.arg(fencing_generation),
    sqlc.arg(capture_epoch), sqlc.arg(claim_request_id), sqlc.arg(kind),
    sqlc.arg(lease_owner), sqlc.arg(lease_token), sqlc.arg(lease_expires_at),
    sqlc.arg(envelope_bytes), sqlc.arg(envelope_digest), sqlc.arg(issued_at)
)
returning job_id, attempt_count, fencing_generation, capture_epoch,
    claim_request_id, kind, lease_owner, lease_token, lease_expires_at,
    envelope_bytes, envelope_digest, issued_at;

-- name: HeartbeatRecordingJob :one
update recording_jobs
set lease_expires_at = case when recording_jobs.kind in ('render', 'transcription') then least(
        sqlc.arg(lease_expires_at)::timestamptz,
        (select (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'hard_deadline')::timestamptz
         from recording_job_attempt_authorities authority
         where authority.job_id = recording_jobs.id
           and authority.attempt_count = recording_jobs.attempt_count
           and authority.fencing_generation = recording_jobs.fencing_generation))
        else least(sqlc.arg(lease_expires_at)::timestamptz,
            (select recovery.source_expires_at from recording_completion_recoveries recovery
             where recovery.job_id = recording_jobs.id
               and recovery.fencing_generation + 1 = recording_jobs.fencing_generation),
            (select case when (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean is true
                         then recording_capture_salvage_deadline(recording_jobs.recording_id) end
             from recording_job_attempt_authorities authority
             where authority.job_id = recording_jobs.id
               and authority.attempt_count = recording_jobs.attempt_count
               and authority.fencing_generation = recording_jobs.fencing_generation)) end, updated_at = now()
where id = sqlc.arg(id)
  and state = 'leased'
  and recording_jobs.attempt_count = sqlc.arg(attempt_count)
  and recording_jobs.fencing_generation = sqlc.arg(fencing_generation)
  and recording_jobs.lease_token = sqlc.arg(lease_token)
  and recording_jobs.lease_owner = sqlc.arg(lease_owner)
  and recording_jobs.lease_expires_at > clock_timestamp()
  and exists (
      select 1 from recording_job_attempt_authorities authority
      where authority.job_id = recording_jobs.id
        and authority.kind = recording_jobs.kind
        and ((convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'completion_only')::boolean is not true
             or recording_capture_completion_available(recording_jobs.recording_id))
        and (recording_jobs.kind not in ('render', 'transcription') or
            (convert_from(authority.envelope_bytes, 'UTF8')::jsonb ->> 'hard_deadline')::timestamptz > clock_timestamp())
        and authority.attempt_count = sqlc.arg(attempt_count)
        and authority.fencing_generation = sqlc.arg(fencing_generation)
        and authority.capture_epoch = sqlc.arg(capture_epoch)
        and authority.envelope_digest = sqlc.arg(envelope_digest)
        and authority.lease_token = sqlc.arg(lease_token)
        and authority.lease_owner = sqlc.arg(lease_owner)
  )
returning id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at, result_metadata;

-- name: CompleteRecordingJob :one
update recording_jobs
set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
    terminal_at = now(), updated_at = now()
where id = sqlc.arg(id)
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
returning id, tenant_id, episode_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at, result_metadata;

-- name: RequestDeferredRecordingRender :one
-- Automatic capture completion queues the canonical MP4 export. Requests
-- reuse it, or create it for retained on-demand captures. A
-- terminally failed job may be manually retried five times; each old failure
-- is copied to append-only history before the same fenced job is requeued.
with candidate as (
    select pipelines.recording_id, pipelines.state, pipelines.capture_completed_at,
        episodes.config_snapshot
    from recording_pipelines pipelines
    join recordings on recordings.id = pipelines.recording_id
    join episodes on episodes.id = recordings.episode_id
    join tenants on tenants.id = pipelines.tenant_id
    where (sqlc.arg(allow_manual_retry)::boolean or tenants.recording_render_mode = 'automatic')
      and pipelines.recording_id = sqlc.arg(recording_id)
      and pipelines.tenant_id = sqlc.arg(tenant_id)
      and recordings.tenant_id = sqlc.arg(tenant_id)
    for update of pipelines for share of tenants
), existing as (
    select jobs.*
    from recording_jobs jobs
    join candidate on candidate.recording_id = jobs.recording_id
    where jobs.kind = 'render'
), retry_tally as (
    select existing.id as job_id, count(history.job_id)::integer as retry_count
    from existing
    left join recording_job_failure_history history on history.job_id = existing.id
    group by existing.id
), archived_failure as (
    insert into recording_job_failure_history (
        job_id, manual_retry_count, attempt_count, fencing_generation,
        error_code, error_detail, failed_at
    )
    select existing.id, retry_tally.retry_count + 1, existing.attempt_count,
        existing.fencing_generation, existing.error_code, existing.error_detail,
        coalesce(existing.terminal_at, existing.updated_at)
    from existing
    join retry_tally on retry_tally.job_id = existing.id
    join candidate on candidate.recording_id = existing.recording_id
    where existing.state = 'terminal_failure'
      and sqlc.arg(allow_manual_retry)::boolean
      and retry_tally.retry_count < 5
      and candidate.capture_completed_at +
          (recording_deferred_retention_seconds(candidate.config_snapshot) * interval '1 second') > clock_timestamp()
    on conflict (job_id, manual_retry_count) do nothing
    returning job_id, manual_retry_count
), retried as (
    update recording_jobs jobs
    set state = 'pending', available_at = now(), attempt_count = 0,
        lease_token = null, lease_owner = null, lease_expires_at = null,
        error_code = null, error_detail = null, terminal_at = null, updated_at = now()
    from archived_failure
    where jobs.id = archived_failure.job_id
      and jobs.state = 'terminal_failure'
    returning jobs.*
), inserted as (
    insert into recording_jobs (
        id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select sqlc.arg(render_job_id), recordings.tenant_id, recordings.episode_id,
        recordings.id, 'render', 'render:' || recordings.id::text,
        sqlc.arg(payload_schema_version), 'pending', sqlc.arg(priority), now(),
        sqlc.arg(attempt_limit)
    from candidate
    join recordings on recordings.id = candidate.recording_id
    where candidate.state = 'capture_complete'
      and candidate.capture_completed_at is not null
      and candidate.capture_completed_at +
          (recording_deferred_retention_seconds(candidate.config_snapshot) * interval '1 second') > clock_timestamp()
    on conflict (recording_id, kind) do nothing
    returning *
), backfill_journey as (
    insert into observability_journey_events (
        event_id, journey_id, sequence, occurred_at, name, phase, state,
        origin_kind, first_observed_layer, upstream_visibility, trace_id, span_id, attributes
    )
    select inserted.id, coalesce(sqlc.narg(journey_id)::uuid, inserted.recording_id),
        coalesce((select max(sequence) + 1 from observability_journey_events
                  where journey_id = coalesce(sqlc.narg(journey_id)::uuid, inserted.recording_id)), 0),
        now(), 'recording.render.queued', 'render', 'queued', 'worker', 'api', 'visible',
        sqlc.narg(trace_id)::text, sqlc.narg(span_id)::text,
        jsonb_build_object('tenant_id', inserted.tenant_id, 'episode_id', inserted.episode_id,
            'recording_id', inserted.recording_id, 'render_job_id', inserted.id, 'trigger', 'backfill')
    from inserted
    where not sqlc.arg(allow_manual_retry)::boolean
), queued as (
    update recording_pipelines
    set state = 'render_queued', updated_at = now()
    where recording_pipelines.recording_id in (
        select recording_id from inserted union all select recording_id from retried
    )
      and recording_pipelines.state in ('capture_complete', 'terminal_failure')
    returning recording_pipelines.recording_id
)
select existing.*, (sqlc.arg(allow_manual_retry)::boolean and existing.state = 'terminal_failure' and retry_tally.retry_count >= 5) as retry_limit_reached
from existing
join retry_tally on retry_tally.job_id = existing.id
where not sqlc.arg(allow_manual_retry)::boolean or existing.state <> 'terminal_failure' or retry_tally.retry_count >= 5
union all
select retried.*, false as retry_limit_reached from retried
union all
select inserted.*, false as retry_limit_reached from inserted
limit 1;
