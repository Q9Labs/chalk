-- name: CreateRecordingReservation :one
with existing as (
    select id, tenant_id, room_id, session_id, recording_id, idempotency_key,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at, request_fingerprint
    from recording_reservations
    where recording_reservations.tenant_id = sqlc.arg(tenant_id)
      and recording_reservations.idempotency_key = sqlc.arg(idempotency_key)
), locked_capacity as (
    select reserved_meetings, reserved_participants, reserved_input_bitrate_bps
    from recording_capacity
    where id = 1
      and not exists (select 1 from existing)
      and (select count(*) from recording_pool_health
           where role in ('capture', 'render')
             and admission_open
             and ready_capacity > 0
             and observed_at > now() - interval '2 minutes'
             and observed_at <= now()) = 2
    for update
), capacity_update as (
    update recording_capacity
    set reserved_meetings = recording_capacity.reserved_meetings + sqlc.arg(participant_meetings)::integer,
        reserved_participants = recording_capacity.reserved_participants + sqlc.arg(participant_count)::integer,
        reserved_input_bitrate_bps = recording_capacity.reserved_input_bitrate_bps + sqlc.arg(input_bitrate_bps)::bigint,
        updated_at = now()
    from locked_capacity
    where recording_capacity.id = 1
      and locked_capacity.reserved_meetings + sqlc.arg(participant_meetings)::integer <= 20
      and locked_capacity.reserved_participants + sqlc.arg(participant_count)::integer <= 100
      and locked_capacity.reserved_input_bitrate_bps + sqlc.arg(input_bitrate_bps)::bigint <= 80000000
      and exists (
          select 1 from room_sessions
          where room_sessions.tenant_id = sqlc.arg(tenant_id)
            and room_sessions.room_id = sqlc.arg(room_id)
            and room_sessions.id = sqlc.arg(session_id)
      )
    returning recording_capacity.id
), legacy_recording as (
    insert into recordings (id, tenant_id, room_id, session_id, status, storage_provider)
    select sqlc.arg(recording_id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(session_id), 'pending', 'r2'
    from capacity_update
    join room_sessions on room_sessions.tenant_id = sqlc.arg(tenant_id)
        and room_sessions.room_id = sqlc.arg(room_id)
        and room_sessions.id = sqlc.arg(session_id)
    where not exists (select 1 from existing)
    on conflict (id) do nothing
    returning id
), reservation as (
    insert into recording_reservations (
        id, tenant_id, room_id, session_id, recording_id, idempotency_key, request_fingerprint,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at
    )
    select
        sqlc.arg(id), sqlc.arg(tenant_id), sqlc.arg(room_id), sqlc.arg(session_id), sqlc.arg(recording_id),
        sqlc.arg(idempotency_key), sqlc.arg(request_fingerprint), sqlc.arg(participant_count), sqlc.arg(max_duration_seconds),
        sqlc.arg(input_bitrate_bps), 'reserved', sqlc.narg(starts_at), sqlc.arg(ends_at)
    from capacity_update join legacy_recording on true
    where not exists (select 1 from existing)
    returning id, tenant_id, room_id, session_id, recording_id, idempotency_key,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
), pipeline as (
    insert into recording_pipelines (recording_id, tenant_id, reservation_id, state)
    select recording_id, tenant_id, id, 'reserved'
    from reservation
), capture_job as (
    insert into recording_jobs (
        id, tenant_id, session_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select
        sqlc.arg(capture_job_id), tenant_id, session_id, recording_id, 'capture',
        'capture:' || recording_id::text, sqlc.arg(payload_schema_version), 'pending',
        sqlc.arg(priority), sqlc.arg(available_at), sqlc.arg(attempt_limit)
    from reservation
), replay as (
    select id, tenant_id, room_id, session_id, recording_id, idempotency_key,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
    from existing
    where request_fingerprint = sqlc.arg(request_fingerprint)
)
select reservation.id, reservation.tenant_id, reservation.room_id, reservation.session_id,
    reservation.recording_id, reservation.idempotency_key, reservation.participant_count,
    reservation.max_duration_seconds, reservation.input_bitrate_bps, reservation.state,
    reservation.starts_at, reservation.ends_at, reservation.updated_at, reservation.created_at
from reservation
union all
select replay.id, replay.tenant_id, replay.room_id, replay.session_id,
    replay.recording_id, replay.idempotency_key, replay.participant_count,
    replay.max_duration_seconds, replay.input_bitrate_bps, replay.state,
    replay.starts_at, replay.ends_at, replay.updated_at, replay.created_at
from replay;

-- name: GetRecordingReservation :one
select
    id, tenant_id, room_id, session_id, recording_id, idempotency_key,
    participant_count, max_duration_seconds, input_bitrate_bps, state,
    starts_at, ends_at, updated_at, created_at
from recording_reservations
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: GetRecordingReservationByKey :one
select
    id, tenant_id, room_id, session_id, recording_id, idempotency_key,
    participant_count, max_duration_seconds, input_bitrate_bps, state,
    starts_at, ends_at, updated_at, created_at
from recording_reservations
where tenant_id = sqlc.arg(tenant_id) and idempotency_key = sqlc.arg(idempotency_key)
  and request_fingerprint = sqlc.arg(request_fingerprint);

-- name: GetRecordingReservationFingerprint :one
select request_fingerprint
from recording_reservations
where tenant_id = sqlc.arg(tenant_id) and idempotency_key = sqlc.arg(idempotency_key);

-- name: ReleaseRecordingReservation :one
with locked as (
    select recording_reservations.id, recording_reservations.recording_id,
        recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from recording_reservations
    join recording_pipelines on recording_pipelines.recording_id = recording_reservations.recording_id
    where recording_reservations.tenant_id = sqlc.arg(tenant_id)
      and recording_reservations.id = sqlc.arg(id)
      and recording_reservations.state = 'reserved'
      and recording_pipelines.state = 'reserved'
      and exists (select 1 from recording_jobs
          where recording_jobs.recording_id = recording_reservations.recording_id
            and recording_jobs.kind = 'capture' and recording_jobs.state = 'pending')
    for update
), capacity_update as (
    update recording_capacity
    set reserved_meetings = reserved_meetings - 1,
        reserved_participants = reserved_participants - (select participant_count from locked),
        reserved_input_bitrate_bps = reserved_input_bitrate_bps - (select input_bitrate_bps from locked),
        updated_at = now()
    where id = 1 and exists (select 1 from locked)
), released as (
    update recording_reservations
    set state = sqlc.arg(state), updated_at = now()
    where id = (select id from locked)
    returning id, tenant_id, room_id, session_id, recording_id, idempotency_key,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
), cancelled_job as (
    update recording_jobs
    set state = 'cancelled', terminal_at = now(), updated_at = now()
    where recording_id = (select recording_id from locked)
      and kind = 'capture' and state = 'pending'
    returning recording_id
), deleted_pipeline as (
    update recording_pipelines
    set state = 'deleted', updated_at = now()
    where recording_id = (select recording_id from cancelled_job)
      and state = 'reserved'
    returning recording_id
)
select released.id, released.tenant_id, released.room_id, released.session_id,
    released.recording_id, released.idempotency_key, released.participant_count,
    released.max_duration_seconds, released.input_bitrate_bps, released.state,
    released.starts_at, released.ends_at, released.updated_at, released.created_at
from released join deleted_pipeline on deleted_pipeline.recording_id = released.recording_id;

-- name: ExtendRecordingReservation :one
update recording_reservations
set max_duration_seconds = sqlc.arg(max_duration_seconds),
    ends_at = sqlc.arg(ends_at),
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id)
  and id = sqlc.arg(id)
  and state = 'reserved'
  and sqlc.arg(max_duration_seconds)::integer between max_duration_seconds and 7200
returning id, tenant_id, room_id, session_id, recording_id, idempotency_key,
    participant_count, max_duration_seconds, input_bitrate_bps, state,
    starts_at, ends_at, updated_at, created_at;

-- name: GetRecordingPipeline :one
select recording_id, tenant_id, reservation_id, state, capture_completed_at, committed_at, updated_at, created_at
from recording_pipelines
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id);

-- name: ClaimRecordingJob :one
with candidate as (
    select recording_jobs.id
    from recording_jobs
    join recording_pipelines on recording_pipelines.recording_id = recording_jobs.recording_id
    where recording_jobs.kind = sqlc.arg(kind)
      and recording_jobs.state = 'pending'
      and recording_jobs.available_at <= now()
      and recording_jobs.attempt_count < recording_jobs.attempt_limit
      and ((recording_jobs.kind = 'capture' and recording_pipelines.state in ('reserved', 'retryable_failure'))
        or (recording_jobs.kind = 'render' and recording_pipelines.state in ('render_queued', 'retryable_failure')))
    order by recording_jobs.priority desc, recording_jobs.available_at, recording_jobs.id
    for update of recording_jobs skip locked
    limit 1
), leased as (
    update recording_jobs
    set state = 'leased',
        attempt_count = attempt_count + 1,
        lease_token = sqlc.arg(lease_token),
        lease_owner = sqlc.arg(lease_owner),
        lease_expires_at = sqlc.arg(lease_expires_at),
        fencing_generation = fencing_generation + 1,
        updated_at = now()
    from candidate
    where recording_jobs.id = candidate.id
    returning recording_jobs.id, recording_jobs.tenant_id, recording_jobs.session_id,
        recording_jobs.recording_id, recording_jobs.kind, recording_jobs.idempotency_key,
        recording_jobs.payload_schema_version, recording_jobs.state, recording_jobs.priority,
        recording_jobs.available_at, recording_jobs.attempt_count, recording_jobs.attempt_limit,
        recording_jobs.lease_token, recording_jobs.lease_owner, recording_jobs.lease_expires_at,
        recording_jobs.fencing_generation, recording_jobs.error_code, recording_jobs.error_detail,
        recording_jobs.terminal_at, recording_jobs.updated_at, recording_jobs.created_at
), pipeline as (
    update recording_pipelines
    set state = case when sqlc.arg(kind) = 'capture' then 'capture_leased' else 'rendering' end,
        updated_at = now()
    from leased
    where recording_pipelines.recording_id = leased.recording_id
      and ((sqlc.arg(kind) = 'capture' and recording_pipelines.state in ('reserved', 'retryable_failure'))
        or (sqlc.arg(kind) = 'render' and recording_pipelines.state in ('render_queued', 'retryable_failure')))
    returning recording_pipelines.recording_id
)
select leased.id, leased.tenant_id, leased.session_id, leased.recording_id, leased.kind,
    leased.idempotency_key, leased.payload_schema_version, leased.state, leased.priority,
    leased.available_at, leased.attempt_count, leased.attempt_limit, leased.lease_token,
    leased.lease_owner, leased.lease_expires_at, leased.fencing_generation, leased.error_code,
    leased.error_detail, leased.terminal_at, leased.updated_at, leased.created_at
from leased join pipeline on pipeline.recording_id = leased.recording_id;

-- name: HeartbeatRecordingJob :one
update recording_jobs
set lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
where id = sqlc.arg(id)
  and state = 'leased'
  and attempt_count = sqlc.arg(attempt_count)
  and fencing_generation = sqlc.arg(fencing_generation)
  and lease_token = sqlc.arg(lease_token)
  and lease_owner = sqlc.arg(lease_owner)
returning id, tenant_id, session_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at;

-- name: CompleteRecordingJob :one
update recording_jobs
set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
    terminal_at = now(), updated_at = now()
where id = sqlc.arg(id)
  and state = 'leased'
  and attempt_count = sqlc.arg(attempt_count)
  and fencing_generation = sqlc.arg(fencing_generation)
  and lease_token = sqlc.arg(lease_token)
  and lease_owner = sqlc.arg(lease_owner)
returning id, tenant_id, session_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at;

-- name: CompleteCaptureRecordingJob :one
with completed as (
    update recording_jobs
    set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where recording_jobs.id = sqlc.arg(id)
      and kind = 'capture'
      and state = 'leased'
      and recording_jobs.attempt_count = sqlc.arg(attempt_count)
      and recording_jobs.fencing_generation = sqlc.arg(fencing_generation)
      and recording_jobs.lease_token = sqlc.arg(lease_token)
      and recording_jobs.lease_owner = sqlc.arg(lease_owner)
    returning id, tenant_id, session_id, recording_id, attempt_count, fencing_generation
), pipeline as (
    update recording_pipelines
    set state = 'render_queued', capture_completed_at = now(), updated_at = now()
    from completed
    where recording_pipelines.recording_id = completed.recording_id
    returning recording_pipelines.recording_id, recording_pipelines.reservation_id
), reservation as (
    select recording_pipelines.recording_id, recording_reservations.id,
        recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from pipeline
    join recording_pipelines on recording_pipelines.recording_id = pipeline.recording_id
    join recording_reservations on recording_reservations.id = pipeline.reservation_id
    where recording_reservations.state = 'reserved'
), capacity_release as (
    update recording_capacity
    set reserved_meetings = reserved_meetings - (select count(*) from reservation),
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
        id, tenant_id, session_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select sqlc.arg(render_job_id), tenant_id, session_id, recording_id, 'render',
        'render:' || recording_id::text, sqlc.arg(payload_schema_version), 'pending',
        sqlc.arg(priority), now(), sqlc.arg(attempt_limit)
    from completed
    where exists (select 1 from reservation_release)
    on conflict (recording_id, kind) do nothing
)
select recording_jobs.id, recording_jobs.tenant_id, recording_jobs.session_id,
    recording_jobs.recording_id, recording_jobs.kind, recording_jobs.idempotency_key,
    recording_jobs.payload_schema_version, recording_jobs.state, recording_jobs.priority,
    recording_jobs.available_at, recording_jobs.attempt_count, recording_jobs.attempt_limit,
    recording_jobs.lease_token, recording_jobs.lease_owner, recording_jobs.lease_expires_at,
    recording_jobs.fencing_generation, recording_jobs.error_code, recording_jobs.error_detail,
    recording_jobs.terminal_at, recording_jobs.updated_at, recording_jobs.created_at
from recording_jobs join completed on completed.id = recording_jobs.id;

-- name: FailRecordingJob :one
with failed as (
    update recording_jobs
    set state = case when attempt_count >= attempt_limit then 'terminal_failure' else 'pending' end,
        available_at = sqlc.arg(available_at),
        lease_token = null, lease_owner = null, lease_expires_at = null,
        error_code = sqlc.arg(error_code), error_detail = sqlc.arg(error_detail),
        terminal_at = case when attempt_count >= attempt_limit then now() else null end,
        updated_at = now()
    where recording_jobs.id = sqlc.arg(id)
      and state = 'leased'
      and attempt_count = sqlc.arg(attempt_count)
      and fencing_generation = sqlc.arg(fencing_generation)
      and lease_token = sqlc.arg(lease_token)
      and lease_owner = sqlc.arg(lease_owner)
    returning id, tenant_id, session_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_count,
        attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
        error_code, error_detail, terminal_at, updated_at, created_at
), pipeline as (
    update recording_pipelines
    set state = case when (select state from failed) = 'terminal_failure' then 'terminal_failure' else 'retryable_failure' end,
        updated_at = now()
    from failed
    where recording_pipelines.recording_id = failed.recording_id
    returning recording_pipelines.recording_id, (select state from failed) as job_state
), reservation as (
    select recording_reservations.id, recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from pipeline
    join recording_pipelines on recording_pipelines.recording_id = pipeline.recording_id
    join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
    where pipeline.job_state = 'terminal_failure'
      and recording_reservations.state = 'reserved'
), capacity_release as (
    update recording_capacity
    set reserved_meetings = reserved_meetings - (select count(*) from reservation),
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
select failed.id, failed.tenant_id, failed.session_id, failed.recording_id, failed.kind, failed.idempotency_key,
    failed.payload_schema_version, failed.state, failed.priority, failed.available_at, failed.attempt_count,
    failed.attempt_limit, failed.lease_token, failed.lease_owner, failed.lease_expires_at, failed.fencing_generation,
    failed.error_code, failed.error_detail, failed.terminal_at, failed.updated_at, failed.created_at
from failed cross join (select count(*) from reservation_release) released;

-- name: RecoverExpiredRecordingJobs :many
with recovered as (
    update recording_jobs
    set state = case when attempt_count >= attempt_limit then 'terminal_failure' else 'pending' end,
        available_at = now(), lease_token = null, lease_owner = null, lease_expires_at = null,
        terminal_at = case when attempt_count >= attempt_limit then now() else null end,
        error_code = coalesce(error_code, 'lease_expired'),
        updated_at = now()
    where state = 'leased' and lease_expires_at <= now()
    returning id, tenant_id, session_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_count,
        attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
        error_code, error_detail, terminal_at, updated_at, created_at
), pipeline as (
    update recording_pipelines
    set state = case when recovered.state = 'terminal_failure' then 'terminal_failure' else 'retryable_failure' end,
        updated_at = now()
    from recovered
    where recording_pipelines.recording_id = recovered.recording_id
    returning recording_pipelines.recording_id, recovered.state as job_state
), reservation as (
    select recording_reservations.id, recording_reservations.participant_count, recording_reservations.input_bitrate_bps
    from pipeline
    join recording_pipelines on recording_pipelines.recording_id = pipeline.recording_id
    join recording_reservations on recording_reservations.id = recording_pipelines.reservation_id
    where pipeline.job_state = 'terminal_failure' and recording_reservations.state = 'reserved'
), capacity_release as (
    update recording_capacity
    set reserved_meetings = reserved_meetings - (select count(*) from reservation),
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
select recovered.id, recovered.tenant_id, recovered.session_id, recovered.recording_id, recovered.kind,
    recovered.idempotency_key, recovered.payload_schema_version, recovered.state, recovered.priority,
    recovered.available_at, recovered.attempt_count, recovered.attempt_limit, recovered.lease_token,
    recovered.lease_owner, recovered.lease_expires_at, recovered.fencing_generation, recovered.error_code,
    recovered.error_detail, recovered.terminal_at, recovered.updated_at, recovered.created_at
from recovered cross join (select count(*) from reservation_release) released;

-- name: ListRecordingDeadLetters :many
select id, tenant_id, session_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at
from recording_jobs
where tenant_id = sqlc.arg(tenant_id) and state = 'terminal_failure'
order by terminal_at desc, id desc
limit sqlc.arg(limit_count)::integer;

-- name: ExpireRecordingReservations :many
with expired as (
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
    set reserved_meetings = reserved_meetings - (select count(*) from expired),
        reserved_participants = reserved_participants - coalesce((select sum(participant_count) from expired), 0),
        reserved_input_bitrate_bps = reserved_input_bitrate_bps - coalesce((select sum(input_bitrate_bps) from expired), 0),
        updated_at = now()
    where id = 1 and exists (select 1 from expired)
    returning id
), reservations as (
    update recording_reservations
    set state = 'expired', updated_at = now()
    where id in (select id from expired)
    returning id, tenant_id, room_id, session_id, recording_id, idempotency_key,
        participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
), pipelines as (
    update recording_pipelines
    set state = 'terminal_failure', updated_at = now()
    from reservations cross join capacity_update
    where recording_pipelines.recording_id = reservations.recording_id
      and recording_pipelines.state in ('requested', 'reserved', 'retryable_failure')
    returning recording_pipelines.recording_id
)
select reservations.id, reservations.tenant_id, reservations.room_id, reservations.session_id,
    reservations.recording_id, reservations.idempotency_key, reservations.participant_count,
    reservations.max_duration_seconds, reservations.input_bitrate_bps, reservations.state,
    reservations.starts_at, reservations.ends_at, reservations.updated_at, reservations.created_at
from reservations join pipelines on pipelines.recording_id = reservations.recording_id;

-- name: GetRecordingArtifact :one
select recording_id, tenant_id, render_job_id, object_key, content_type,
    byte_size, checksum, duration_millis, committed_at, created_at
from recording_artifacts
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id);

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
      and attempt_count = sqlc.arg(attempt_count)
      and fencing_generation = sqlc.arg(fencing_generation)
      and lease_token = sqlc.arg(lease_token)
      and lease_owner = sqlc.arg(lease_owner)
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
    select recording_jobs.id, recording_jobs.recording_id, recording_jobs.tenant_id
    from recording_jobs
    join recording_pipelines on recording_pipelines.recording_id = recording_jobs.recording_id
    where recording_jobs.id = sqlc.arg(render_job_id)
      and recording_jobs.tenant_id = sqlc.arg(tenant_id)
      and recording_jobs.recording_id = sqlc.arg(recording_id)
      and recording_jobs.kind = 'render'
      and recording_jobs.state = 'leased'
      and recording_jobs.attempt_count = sqlc.arg(attempt_count)
      and recording_jobs.fencing_generation = sqlc.arg(fencing_generation)
      and recording_jobs.lease_token = sqlc.arg(lease_token)
      and recording_jobs.lease_owner = sqlc.arg(lease_owner)
      and recording_pipelines.state = 'rendering'
), artifact as (
    insert into recording_artifacts (
        recording_id, tenant_id, render_job_id, object_key, content_type,
        byte_size, checksum, duration_millis, committed_at
    )
    select authorized.recording_id, authorized.tenant_id, authorized.id,
        sqlc.arg(object_key), sqlc.arg(content_type), sqlc.arg(byte_size),
        sqlc.arg(checksum), sqlc.arg(duration_millis), now()
    from authorized
    on conflict (recording_id) do nothing
    returning recording_id, tenant_id, render_job_id, object_key, content_type,
        byte_size, checksum, duration_millis, committed_at, created_at
), completed as (
    update recording_jobs
    set state = 'succeeded', lease_token = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    from artifact
    where recording_jobs.id = artifact.render_job_id
    returning recording_jobs.recording_id
), pipeline as (
    update recording_pipelines
    set state = 'committed', committed_at = now(), updated_at = now()
    from completed
    where recording_pipelines.recording_id = completed.recording_id
    returning recording_pipelines.recording_id
)
select artifact.recording_id, artifact.tenant_id, artifact.render_job_id,
    artifact.object_key, artifact.content_type, artifact.byte_size, artifact.checksum,
    artifact.duration_millis, artifact.committed_at, artifact.created_at
from artifact join pipeline on pipeline.recording_id = artifact.recording_id;

-- name: ListRecordingJobsForReconciliation :many
select id, tenant_id, session_id, recording_id, kind, idempotency_key,
    payload_schema_version, state, priority, available_at, attempt_count,
    attempt_limit, lease_token, lease_owner, lease_expires_at, fencing_generation,
    error_code, error_detail, terminal_at, updated_at, created_at
from recording_jobs
where (state = 'leased' and lease_expires_at <= now())
   or (state = 'pending' and available_at < sqlc.arg(stale_before))
   or (state = 'terminal_failure' and terminal_at < sqlc.arg(terminal_before))
order by updated_at, id
limit sqlc.arg(limit_count)::integer;
