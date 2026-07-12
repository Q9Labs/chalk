-- name: CreateTranscriptionCleanupJob :one
insert into transcription_cleanup_jobs (
    id, tenant_id, transcript_id, object_key, object_kind, due_at
) values ($1, $2, $3, $4, $5, $6)
on conflict (transcript_id, object_key) do update set
    due_at = least(transcription_cleanup_jobs.due_at, excluded.due_at),
    updated_at = now()
returning *;

-- name: ClaimTranscriptionCleanupJob :one
with expired_terminal as (
    update transcription_cleanup_jobs
    set state = 'dead_letter', error_code = 'lease_expired',
        error_detail = 'cleanup lease expired at attempt limit',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        updated_at = now()
    where state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz
      and attempt_count >= attempt_limit
    returning id
), candidate as (
    select id from transcription_cleanup_jobs
    where (
        (state in ('pending', 'retryable') and due_at <= sqlc.arg(now)::timestamptz)
        or (state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz and attempt_count < attempt_limit)
    )
      and not exists (select 1 from expired_terminal e where e.id = transcription_cleanup_jobs.id)
    order by due_at asc, created_at asc, id asc
    for update skip locked
    limit 1
)
update transcription_cleanup_jobs jobs
set state = 'leased', attempt_count = jobs.attempt_count + 1,
    lease_token_hash = sqlc.arg(lease_token_hash), lease_owner = sqlc.arg(lease_owner),
    lease_expires_at = sqlc.arg(lease_expires_at), updated_at = now()
from candidate
where jobs.id = candidate.id and jobs.attempt_count < jobs.attempt_limit
returning jobs.*;

-- name: GetTranscriptionCleanupJob :one
select * from transcription_cleanup_jobs where id = sqlc.arg(id);

-- name: CompleteTranscriptionCleanupJob :one
update transcription_cleanup_jobs
set state = 'completed', verified_at = now(), lease_token_hash = null,
    lease_owner = null, lease_expires_at = null, updated_at = now()
where id = sqlc.arg(id) and state = 'leased' and attempt_count = sqlc.arg(attempt)
  and lease_owner = sqlc.arg(lease_owner) and lease_token_hash = sqlc.arg(lease_token_hash)
  and lease_expires_at > sqlc.arg(now)::timestamptz
returning *;

-- name: RetryTranscriptionCleanupJob :one
update transcription_cleanup_jobs
set state = case when sqlc.arg(terminal)::boolean or attempt_count >= attempt_limit then 'dead_letter' else 'retryable' end,
    due_at = sqlc.arg(due_at), error_code = sqlc.arg(error_code), error_detail = sqlc.narg(error_detail),
    lease_token_hash = null, lease_owner = null, lease_expires_at = null, updated_at = now()
where id = sqlc.arg(id) and state = 'leased' and attempt_count = sqlc.arg(attempt)
  and lease_owner = sqlc.arg(lease_owner) and lease_token_hash = sqlc.arg(lease_token_hash)
  and lease_expires_at > sqlc.arg(now)::timestamptz
returning *;

-- name: RecoverExpiredTranscriptionCleanupJobs :many
update transcription_cleanup_jobs
set state = case when attempt_count >= attempt_limit then 'dead_letter' else 'retryable' end,
    due_at = sqlc.arg(due_at), error_code = 'lease_expired', error_detail = 'cleanup lease expired',
    lease_token_hash = null, lease_owner = null, lease_expires_at = null, updated_at = now()
where state = 'leased' and lease_expires_at <= sqlc.arg(now)::timestamptz
returning *;
