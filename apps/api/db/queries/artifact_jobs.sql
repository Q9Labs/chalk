-- name: CreateArtifactJob :one
insert into artifact_jobs (
    id, idempotency_key, tenant_id, session_id, recording_id, transcript_id,
    chunk_id, artifact_kind, payload_schema_version, state, priority,
    available_at, attempt_limit, journey_id, traceparent, tracestate
) values (
    sqlc.arg(id), sqlc.arg(idempotency_key), sqlc.arg(tenant_id), sqlc.narg(session_id),
    sqlc.narg(recording_id), sqlc.narg(transcript_id), sqlc.narg(chunk_id),
    sqlc.arg(artifact_kind), sqlc.arg(payload_schema_version), 'pending', sqlc.arg(priority),
    sqlc.arg(available_at), sqlc.arg(attempt_limit), sqlc.narg(journey_id),
    sqlc.narg(traceparent), sqlc.narg(tracestate)
)
returning *;

-- name: CreateTranscriptionFinalizerJobIfReady :one
insert into artifact_jobs (
    id, idempotency_key, tenant_id, session_id, recording_id, transcript_id,
    artifact_kind, payload_schema_version, state, priority, available_at,
    attempt_limit, journey_id, traceparent, tracestate
)
select sqlc.arg(id), 'transcription-finalize-' || t.id::text, t.tenant_id, t.session_id,
    t.recording_id, t.id, 'transcription_finalize', 1, 'pending', sqlc.arg(priority),
    sqlc.arg(available_at), sqlc.arg(attempt_limit), sqlc.narg(journey_id),
    sqlc.narg(traceparent), sqlc.narg(tracestate)
from transcriptions t
where t.id = sqlc.arg(transcript_id)
  and exists (select 1 from transcript_chunks c where c.transcript_id = t.id)
  and not exists (select 1 from artifact_jobs j where j.transcript_id = t.id and j.artifact_kind = 'transcription_chunk' and j.state <> 'completed')
on conflict (tenant_id, idempotency_key) do nothing
returning *;

-- name: GetArtifactJobByIdempotency :one
select * from artifact_jobs
where tenant_id = sqlc.arg(tenant_id) and idempotency_key = sqlc.arg(idempotency_key);

-- name: GetArtifactJob :one
select * from artifact_jobs where id = sqlc.arg(id);

-- name: ListTranscriptionChunkJobs :many
select * from artifact_jobs
where transcript_id = sqlc.arg(transcript_id)
  and artifact_kind = 'transcription_chunk'
order by created_at asc, id asc;

-- name: ListTranscriptionFinalizerJobs :many
select * from artifact_jobs
where transcript_id = sqlc.arg(transcript_id)
  and artifact_kind = 'transcription_finalize'
order by created_at asc, id asc;

-- name: GetTranscriptionChunkJob :one
select * from artifact_jobs
where transcript_id = sqlc.arg(transcript_id) and artifact_kind = 'transcription_chunk'
order by created_at asc, id asc
limit 1;

-- name: ClaimArtifactJob :one
with expired_terminal as (
    update artifact_jobs
    set state = 'dead_letter', error_code = 'lease_expired',
        error_detail = 'worker lease expired at attempt limit',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where artifact_kind = 'transcription_chunk' and state = 'leased'
      and lease_expires_at <= sqlc.arg(now)::timestamptz
      and attempt_count >= attempt_limit
    returning *
), failed as (
    select id, transcript_id from expired_terminal
    where transcript_id is not null
), projection_targets as (
    select transcript_id, true as terminal
    from failed
    group by transcript_id
), projected as (
    update transcriptions t
    set status = 'terminal_failure', updated_at = now()
    from projection_targets p
    where t.id = p.transcript_id and t.status not in ('deleted', 'complete')
    returning t.id
), cancelled as (
    update artifact_jobs j
    set state = 'cancelled', error_code = 'transcript_terminal_failure',
        error_detail = 'transcription job reached terminal failure',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where j.transcript_id in (select transcript_id from failed)
      and j.id not in (select id from failed)
      and j.state in ('pending', 'retryable', 'leased')
      and exists (select 1 from projected p where p.id = j.transcript_id)
), candidate as (
    select id from artifact_jobs
    where artifact_kind = 'transcription_chunk'
      and (
        (state in ('pending', 'retryable') and available_at <= sqlc.arg(now)::timestamptz)
        or (state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz and attempt_count < attempt_limit)
      )
      and not exists (select 1 from expired_terminal e where e.id = artifact_jobs.id)
    order by priority desc, available_at asc, created_at asc, id asc
    for update skip locked
    limit 1
)
update artifact_jobs jobs
set state = 'leased', attempt_count = jobs.attempt_count + 1,
    lease_token_hash = sqlc.arg(lease_token_hash), lease_owner = sqlc.arg(lease_owner),
    lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
from candidate
where jobs.id = candidate.id and jobs.attempt_count < jobs.attempt_limit
returning jobs.*;

-- name: ClaimTranscriptionFinalizerJob :one
with expired_terminal as (
    update artifact_jobs
    set state = 'dead_letter', error_code = 'lease_expired',
        error_detail = 'finalizer lease expired at attempt limit',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where artifact_kind = 'transcription_finalize' and state = 'leased'
      and lease_expires_at <= sqlc.arg(now)::timestamptz
      and attempt_count >= attempt_limit
    returning *
), failed as (
    select id, transcript_id from expired_terminal
    where transcript_id is not null
), projection_targets as (
    select transcript_id, true as terminal
    from failed
    group by transcript_id
), projected as (
    update transcriptions t
    set status = 'terminal_failure', updated_at = now()
    from projection_targets p
    where t.id = p.transcript_id and t.status not in ('deleted', 'complete')
    returning t.id
), cancelled as (
    update artifact_jobs j
    set state = 'cancelled', error_code = 'transcript_terminal_failure',
        error_detail = 'transcription job reached terminal failure',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where j.transcript_id in (select transcript_id from failed)
      and j.id not in (select id from failed)
      and j.state in ('pending', 'retryable', 'leased')
      and exists (select 1 from projected p where p.id = j.transcript_id)
), candidate as (
    select id from artifact_jobs
    where artifact_kind = 'transcription_finalize'
      and (
        (state in ('pending', 'retryable') and available_at <= sqlc.arg(now)::timestamptz)
        or (state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz and attempt_count < attempt_limit)
      )
      and not exists (select 1 from expired_terminal e where e.id = artifact_jobs.id)
    order by priority desc, available_at asc, created_at asc, id asc
    for update skip locked
    limit 1
)
update artifact_jobs jobs
set state = 'leased', attempt_count = jobs.attempt_count + 1,
    lease_token_hash = sqlc.arg(lease_token_hash), lease_owner = sqlc.arg(lease_owner),
    lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
from candidate
where jobs.id = candidate.id and jobs.attempt_count < jobs.attempt_limit
returning jobs.*;

-- name: HeartbeatArtifactJob :one
update artifact_jobs
set lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
where id = sqlc.arg(id) and state = 'leased' and attempt_count = sqlc.arg(attempt)
  and lease_owner = sqlc.arg(lease_owner) and lease_token_hash = sqlc.arg(lease_token_hash)
  and lease_expires_at > sqlc.arg(now)::timestamptz
returning *;

-- name: CompleteArtifactJob :one
update artifact_jobs
set state = 'completed', lease_token_hash = null, lease_owner = null,
    lease_expires_at = null, terminal_at = now(), updated_at = now()
where id = sqlc.arg(id) and state = 'leased' and attempt_count = sqlc.arg(attempt)
  and lease_owner = sqlc.arg(lease_owner) and lease_token_hash = sqlc.arg(lease_token_hash)
  and lease_expires_at > sqlc.arg(now)::timestamptz
returning *;

-- name: RetryArtifactJob :one
with updated as (
    update artifact_jobs
    set state = case when sqlc.arg(terminal)::boolean or attempt_count >= attempt_limit then 'dead_letter' else 'retryable' end,
        available_at = sqlc.arg(available_at), error_code = sqlc.arg(error_code),
        error_detail = sqlc.narg(error_detail), lease_token_hash = null, lease_owner = null,
        lease_expires_at = null, terminal_at = case when sqlc.arg(terminal)::boolean or attempt_count >= attempt_limit then now() else null end,
        updated_at = now()
    where artifact_jobs.id = sqlc.arg(id) and artifact_jobs.state = 'leased' and artifact_jobs.attempt_count = sqlc.arg(attempt)
      and artifact_jobs.lease_owner = sqlc.arg(lease_owner) and artifact_jobs.lease_token_hash = sqlc.arg(lease_token_hash)
      and artifact_jobs.lease_expires_at > sqlc.arg(now)::timestamptz
    returning *
), failed as (
    select id, transcript_id from updated
    where state = 'dead_letter' and transcript_id is not null
), projection_targets as (
    select transcript_id, bool_or(state = 'dead_letter') as terminal
    from updated
    where transcript_id is not null and state in ('retryable', 'dead_letter')
    group by transcript_id
), projected as (
    update transcriptions t
    set status = case when p.terminal then 'terminal_failure' else 'retryable_failure' end,
        updated_at = now()
    from projection_targets p
    where t.id = p.transcript_id
      and t.status not in ('deleted', 'complete')
    returning t.id
), cancelled as (
    update artifact_jobs j
    set state = 'cancelled', error_code = 'transcript_terminal_failure',
        error_detail = 'transcription job reached terminal failure',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where j.transcript_id in (select transcript_id from failed)
      and j.id not in (select id from failed)
      and j.state in ('pending', 'retryable', 'leased')
      and exists (select 1 from projected p where p.id = j.transcript_id)
)
select artifact_jobs.* from artifact_jobs
where artifact_jobs.id in (select id from updated);

-- name: CancelArtifactJob :one
update artifact_jobs
set state = 'cancelled', error_code = sqlc.arg(error_code), error_detail = sqlc.narg(error_detail),
    lease_token_hash = null, lease_owner = null, lease_expires_at = null,
    terminal_at = now(), updated_at = now()
where id = sqlc.arg(id) and state in ('pending', 'retryable', 'leased')
  and (state <> 'leased' or (attempt_count = sqlc.arg(attempt)
      and lease_owner = sqlc.arg(lease_owner) and lease_token_hash = sqlc.arg(lease_token_hash)
      and lease_expires_at > sqlc.arg(now)::timestamptz))
returning *;

-- name: RequeueArtifactJob :one
update artifact_jobs
set state = 'retryable', available_at = sqlc.arg(available_at), error_code = null,
    error_detail = null, terminal_at = null, updated_at = now()
where id = sqlc.arg(id) and state = 'dead_letter'
returning *;

-- name: RecoverExpiredArtifactJobs :many
with updated as (
    update artifact_jobs
    set state = case when attempt_count >= attempt_limit then 'dead_letter' else 'retryable' end,
        available_at = sqlc.arg(available_at), error_code = 'lease_expired',
        error_detail = 'worker lease expired', lease_token_hash = null, lease_owner = null,
        lease_expires_at = null, terminal_at = case when attempt_count >= attempt_limit then now() else null end,
        updated_at = now()
    where state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz
    returning *
), failed as (
    select id, transcript_id from updated
    where state = 'dead_letter' and transcript_id is not null
), projection_targets as (
    select transcript_id, bool_or(state = 'dead_letter') as terminal
    from updated
    where transcript_id is not null and state in ('retryable', 'dead_letter')
    group by transcript_id
), projected as (
    update transcriptions t
    set status = case when p.terminal then 'terminal_failure' else 'retryable_failure' end,
        updated_at = now()
    from projection_targets p
    where t.id = p.transcript_id
      and t.status not in ('deleted', 'complete')
    returning t.id
), cancelled as (
    update artifact_jobs j
    set state = 'cancelled', error_code = 'transcript_terminal_failure',
        error_detail = 'transcription job reached terminal failure',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where j.transcript_id in (select transcript_id from failed)
      and j.id not in (select id from failed)
      and j.state in ('pending', 'retryable', 'leased')
      and exists (select 1 from projected p where p.id = j.transcript_id)
)
select artifact_jobs.* from artifact_jobs
where artifact_jobs.id in (select id from updated);
