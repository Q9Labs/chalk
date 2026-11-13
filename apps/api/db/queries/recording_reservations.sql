-- name: LockRecordingCapacity :one
select id from recording_capacity where id = 1 for update;

-- name: CreateRecordingReservation :one
with existing as (
    select id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at, request_fingerprint
    from recording_reservations
    where recording_reservations.tenant_id = sqlc.arg(tenant_id)
      and recording_reservations.idempotency_key = sqlc.arg(idempotency_key)
), locked_capacity as (
    select reserved_episodes, reserved_participants, reserved_input_bitrate_bps
    from recording_capacity
    where id = 1
      and not exists (select 1 from existing)
    for update
), capacity_update as (
    update recording_capacity
    set reserved_episodes = recording_capacity.reserved_episodes + sqlc.arg(episode_count)::integer,
        reserved_participants = recording_capacity.reserved_participants + sqlc.arg(participant_count)::integer,
        reserved_input_bitrate_bps = recording_capacity.reserved_input_bitrate_bps + sqlc.arg(input_bitrate_bps)::bigint,
        updated_at = now()
    from locked_capacity
    where recording_capacity.id = 1
      -- Storage retains the prior bound so grandfathered reservations can drain;
      -- these predicates are the launch policy for new admission.
      and locked_capacity.reserved_episodes + sqlc.arg(episode_count)::integer <= coalesce(nullif(sqlc.arg(recording_cap)::integer, 0), 10)
      and locked_capacity.reserved_participants + sqlc.arg(participant_count)::integer <= coalesce(nullif(sqlc.arg(participant_cap)::integer, 0), 100)
      and locked_capacity.reserved_input_bitrate_bps + sqlc.arg(input_bitrate_bps)::bigint <= coalesce(nullif(sqlc.arg(bitrate_cap_bps)::bigint, 0), 40000000)
      and exists (
          select 1 from episodes
          where episodes.tenant_id = sqlc.arg(tenant_id)
            and episodes.space_id = sqlc.arg(space_id)
            and episodes.id = sqlc.arg(episode_id)
      )
      and (
          not exists (
              select 1 from recordings
              where recordings.id = sqlc.arg(recording_id)
          )
          or exists (
              select 1 from recordings
              where recordings.id = sqlc.arg(recording_id)
                and recordings.tenant_id = sqlc.arg(tenant_id)
                and recordings.space_id = sqlc.arg(space_id)
                and recordings.episode_id = sqlc.arg(episode_id)
                and recordings.status in ('pending', 'processing')
          )
      )
    returning recording_capacity.id
), materialized_recording as (
    insert into recordings (id, tenant_id, space_id, episode_id, status, storage_provider)
    select sqlc.arg(recording_id), sqlc.arg(tenant_id), sqlc.arg(space_id), sqlc.arg(episode_id), 'pending', 'r2'
    from capacity_update
    join episodes on episodes.tenant_id = sqlc.arg(tenant_id)
        and episodes.space_id = sqlc.arg(space_id)
        and episodes.id = sqlc.arg(episode_id)
    where not exists (select 1 from existing)
    on conflict (id) do update
    set updated_at = recordings.updated_at
    where recordings.tenant_id = excluded.tenant_id
      and recordings.space_id = excluded.space_id
      and recordings.episode_id = excluded.episode_id
      and recordings.status in ('pending', 'processing')
    returning id, tenant_id, space_id, episode_id
), recording as (
    select id, tenant_id, space_id, episode_id
    from materialized_recording
    union all
    select recordings.id, recordings.tenant_id, recordings.space_id, recordings.episode_id
    from recordings
    where recordings.id = sqlc.arg(recording_id)
      and recordings.tenant_id = sqlc.arg(tenant_id)
      and recordings.space_id = sqlc.arg(space_id)
      and recordings.episode_id = sqlc.arg(episode_id)
      and recordings.status in ('pending', 'processing')
      and not exists (select 1 from existing)
      and not exists (select 1 from materialized_recording)
), reservation as (
    insert into recording_reservations (
        id, tenant_id, space_id, episode_id, recording_id, idempotency_key, request_fingerprint,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at
    )
    select
        sqlc.arg(id), recording.tenant_id, recording.space_id, recording.episode_id, recording.id,
        sqlc.arg(idempotency_key), sqlc.arg(request_fingerprint), sqlc.arg(policy_snapshot_version), sqlc.arg(participant_count), sqlc.arg(max_duration_seconds),
        sqlc.arg(input_bitrate_bps), 'reserved', sqlc.narg(starts_at), sqlc.arg(ends_at)
    from capacity_update join recording on true
    where not exists (select 1 from existing)
    returning id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
), consumed_preparation as (
    update recording_preparations preparation
    set state = 'consumed', consumed_recording_id = reservation.recording_id,
        revision = preparation.revision + 1, updated_at = now()
    from reservation
    where preparation.tenant_id = reservation.tenant_id and preparation.space_id = reservation.space_id
      and preparation.state = 'scheduled' and reservation.starts_at is null
      and preparation.starts_at <= now() + interval '5 minutes'
      and preparation.starts_at > now() - interval '5 minutes'
    returning preparation.consumed_recording_id
), pipeline as (
    insert into recording_pipelines (recording_id, tenant_id, reservation_id, state)
    select recording_id, tenant_id, id, 'reserved'
    from reservation
), capture_job as (
    insert into recording_jobs (
        id, tenant_id, episode_id, recording_id, kind, idempotency_key,
        payload_schema_version, state, priority, available_at, attempt_limit
    )
    select
        sqlc.arg(capture_job_id), tenant_id, episode_id, recording_id, 'capture',
        'capture:' || recording_id::text, sqlc.arg(payload_schema_version), 'pending',
        sqlc.arg(priority), sqlc.arg(available_at), sqlc.arg(attempt_limit)
    from reservation
), replay as (
    select id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
        starts_at, ends_at, updated_at, created_at
    from existing
    where request_fingerprint = sqlc.arg(request_fingerprint)
)
select reservation.id, reservation.tenant_id, reservation.space_id, reservation.episode_id,
    reservation.recording_id, reservation.idempotency_key, reservation.policy_snapshot_version, reservation.participant_count,
    reservation.max_duration_seconds, reservation.input_bitrate_bps, reservation.state,
    reservation.starts_at, reservation.ends_at, reservation.updated_at, reservation.created_at,
    exists (select 1 from consumed_preparation)::boolean as preparation_consumed
from reservation
union all
select replay.id, replay.tenant_id, replay.space_id, replay.episode_id,
    replay.recording_id, replay.idempotency_key, replay.policy_snapshot_version, replay.participant_count,
    replay.max_duration_seconds, replay.input_bitrate_bps, replay.state,
    replay.starts_at, replay.ends_at, replay.updated_at, replay.created_at,
    exists (select 1 from recording_preparations where consumed_recording_id = replay.recording_id)::boolean as preparation_consumed
from replay;

-- name: GetRecordingReservation :one
select
    id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
    policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
    starts_at, ends_at, updated_at, created_at
from recording_reservations
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: GetRecordingReservationByKey :one
select
    id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
    policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
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
    set reserved_episodes = reserved_episodes - 1,
        reserved_participants = reserved_participants - (select participant_count from locked),
        reserved_input_bitrate_bps = reserved_input_bitrate_bps - (select input_bitrate_bps from locked),
        updated_at = now()
    where id = 1 and exists (select 1 from locked)
), released as (
    update recording_reservations
    set state = sqlc.arg(state), updated_at = now()
    where id = (select id from locked)
    returning id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
        policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
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
select released.id, released.tenant_id, released.space_id, released.episode_id,
    released.recording_id, released.idempotency_key, released.policy_snapshot_version, released.participant_count,
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
  and sqlc.arg(max_duration_seconds)::integer between max_duration_seconds and 14400
returning id, tenant_id, space_id, episode_id, recording_id, idempotency_key,
    policy_snapshot_version, participant_count, max_duration_seconds, input_bitrate_bps, state,
    starts_at, ends_at, updated_at, created_at;
