-- name: LockRecordingCapturePlanHandle :exec
select pg_advisory_xact_lock(hashtextextended(sqlc.arg(plan_handle)::text, 2));

-- name: GetRecordingCapturePlanSource :one
select
    authority.envelope_bytes,
    authority.envelope_digest,
    authority.issued_at,
    jobs.id as job_id,
    jobs.tenant_id,
    reservations.space_id,
    jobs.episode_id,
    jobs.recording_id,
    authority.attempt_count,
    authority.fencing_generation,
    authority.capture_epoch,
    reservations.participant_count,
    reservations.input_bitrate_bps,
    reservations.ends_at,
    pipelines.state as pipeline_state,
    pipelines.stop_requested_at,
    control.control_revision as episode_control_revision,
    control.folded_state as episode_folded_state,
    coalesce(participant_snapshot.participants, '[]'::jsonb) as episode_participants,
    coalesce(observation.incarnation, 0)::bigint as provider_incarnation,
    coalesce(observation.sequence, 0)::bigint as provider_sequence,
    coalesce(observation.publications, '[]'::jsonb) as provider_publications
from recording_job_attempt_authorities authority
join recording_jobs jobs on jobs.id = authority.job_id
join recording_pipelines pipelines on pipelines.recording_id = jobs.recording_id
join recording_reservations reservations on reservations.id = pipelines.reservation_id
join sync_episode_control control
  on control.tenant_id = jobs.tenant_id
 and control.space_id = reservations.space_id
 and control.episode_id = jobs.episode_id
left join lateral (
    select incarnation, sequence, publications
    from provider_operation_observations
    where tenant_id = jobs.tenant_id
      and episode_id = jobs.episode_id
    order by incarnation desc, sequence desc
    limit 1
) observation on true
left join lateral (
    select jsonb_agg(
        jsonb_build_object(
            'participant_id', id,
            'generation', generation,
            'status', status
        )
        order by id
    ) as participants
    from participants
    where tenant_id = jobs.tenant_id
      and space_id = reservations.space_id
      and episode_id = jobs.episode_id
      and status in ('active', 'leaving')
) participant_snapshot on true
where authority.job_id = sqlc.arg(job_id)
  and authority.attempt_count = sqlc.arg(attempt_count)
  and authority.fencing_generation = sqlc.arg(fencing_generation)
  and authority.capture_epoch = sqlc.arg(capture_epoch)
  and authority.envelope_digest = sqlc.arg(envelope_digest)
  and authority.lease_token = sqlc.arg(lease_token)
  and authority.lease_owner = sqlc.arg(lease_owner)
  and jobs.kind = 'capture'
  and jobs.state = 'leased'
  and jobs.lease_token = sqlc.arg(lease_token)
  and jobs.lease_owner = sqlc.arg(lease_owner)
  and jobs.lease_expires_at > clock_timestamp()
for update of jobs;

-- name: GetLatestRecordingCapturePlan :one
select plan_handle, revision, job_id, attempt_count, fencing_generation,
    capture_epoch, envelope_digest, tenant_id, space_id, episode_id,
    recording_id, episode_control_revision, provider_incarnation,
    provider_sequence, plan_schema_version, plan_bytes, plan_fingerprint,
    effective_deadline_at, created_at
from recording_capture_plans
where plan_handle = sqlc.arg(plan_handle)
order by revision desc
limit 1;

-- name: InsertRecordingCapturePlan :one
insert into recording_capture_plans (
    plan_handle, revision, job_id, attempt_count, fencing_generation,
    capture_epoch, envelope_digest, tenant_id, space_id, episode_id,
    recording_id, episode_control_revision, provider_incarnation,
    provider_sequence, plan_schema_version, plan_bytes, plan_fingerprint,
    effective_deadline_at
)
values (
    sqlc.arg(plan_handle), sqlc.arg(revision), sqlc.arg(job_id),
    sqlc.arg(attempt_count), sqlc.arg(fencing_generation),
    sqlc.arg(capture_epoch), sqlc.arg(envelope_digest), sqlc.arg(tenant_id),
    sqlc.arg(space_id), sqlc.arg(episode_id), sqlc.arg(recording_id),
    sqlc.arg(episode_control_revision), sqlc.arg(provider_incarnation),
    sqlc.arg(provider_sequence), sqlc.arg(plan_schema_version),
    sqlc.arg(plan_bytes), sqlc.arg(plan_fingerprint),
    sqlc.arg(effective_deadline_at)
)
returning plan_handle, revision, job_id, attempt_count, fencing_generation,
    capture_epoch, envelope_digest, tenant_id, space_id, episode_id,
    recording_id, episode_control_revision, provider_incarnation,
    provider_sequence, plan_schema_version, plan_bytes, plan_fingerprint,
    effective_deadline_at, created_at;
