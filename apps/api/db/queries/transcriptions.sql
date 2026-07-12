-- name: CreateTranscription :one
insert into transcriptions (
    id, tenant_id, recording_id, room_id, session_id, status, provider, model,
    languages, metadata, source_manifest_key, source_manifest_sha256,
    source_manifest_size, source_manifest_content_type, generation
) select
    sqlc.arg(id), recordings.tenant_id, recordings.id, recordings.room_id,
    recordings.session_id, sqlc.arg(status), sqlc.narg(provider), sqlc.narg(model),
    sqlc.arg(languages), sqlc.narg(metadata), sqlc.arg(source_manifest_key),
    sqlc.arg(source_manifest_sha256), sqlc.arg(source_manifest_size),
    sqlc.arg(source_manifest_content_type), sqlc.arg(generation)
from recordings
where recordings.tenant_id = sqlc.arg(tenant_id)
  and recordings.id = sqlc.arg(recording_id)
  and recordings.room_id = sqlc.arg(room_id)
  and recordings.session_id = sqlc.arg(session_id)
  and recordings.status = 'completed'
returning *;

-- name: CreateRequestedTranscription :one
insert into transcriptions (
    id, tenant_id, recording_id, room_id, session_id, status, provider, model,
    languages, metadata, source_manifest_key, source_manifest_sha256,
    source_manifest_size, source_manifest_content_type, generation
) select
    sqlc.arg(id), recordings.tenant_id, recordings.id, recordings.room_id,
    recordings.session_id, sqlc.arg(status), null, null,
    sqlc.arg(languages), sqlc.narg(metadata), sqlc.narg(source_manifest_key),
    sqlc.narg(source_manifest_sha256), sqlc.narg(source_manifest_size),
    sqlc.narg(source_manifest_content_type), sqlc.arg(generation)
from recordings
where recordings.tenant_id = sqlc.arg(tenant_id)
  and recordings.id = sqlc.arg(recording_id)
  and recordings.status = 'completed'
on conflict (recording_id) do nothing
returning *;

-- name: GetTenantTranscription :one
select * from transcriptions
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id);

-- name: GetTenantTranscriptionByRecording :one
select * from transcriptions
where tenant_id = sqlc.arg(tenant_id) and recording_id = sqlc.arg(recording_id);

-- name: LockTenantTranscriptionForUpdate :one
select * from transcriptions
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id)
for update;

-- name: MarkTranscriptionTranscribing :one
update transcriptions
set status = 'transcribing', updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id)
  and status in ('preparing', 'retryable_failure', 'transcribing')
returning *;

-- name: MarkTranscriptionVerifying :one
update transcriptions
set status = 'verifying', updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id)
  and status in ('preparing', 'transcribing', 'retryable_failure', 'verifying')
returning *;

-- name: ListTenantTranscriptions :many
select * from transcriptions
where tenant_id = sqlc.arg(tenant_id)
  and (sqlc.narg(recording_id)::uuid is null or recording_id = sqlc.narg(recording_id)::uuid)
  and (not sqlc.arg(cursor_set)::boolean or (created_at, id) < (sqlc.arg(cursor_created_at)::timestamptz, sqlc.arg(cursor_id)::uuid))
order by created_at desc, id desc
limit sqlc.arg(page_size)::integer;

-- name: UpdateTenantTranscription :one
update transcriptions set
    status = case when sqlc.arg(status_set)::boolean then sqlc.arg(status)::text else status end,
    provider = case when sqlc.arg(provider_set)::boolean then sqlc.narg(provider)::text else provider end,
    model = case when sqlc.arg(model_set)::boolean then sqlc.narg(model)::text else model end,
    languages = case when sqlc.arg(languages_set)::boolean then sqlc.arg(languages)::text[] else languages end,
    artifact_key = case when sqlc.arg(artifact_key_set)::boolean then sqlc.narg(artifact_key)::text else artifact_key end,
    artifact_sha256 = case when sqlc.arg(artifact_sha256_set)::boolean then sqlc.narg(artifact_sha256)::bytea else artifact_sha256 end,
    artifact_size = case when sqlc.arg(artifact_size_set)::boolean then sqlc.narg(artifact_size)::bigint else artifact_size end,
    artifact_content_type = case when sqlc.arg(artifact_content_type_set)::boolean then sqlc.narg(artifact_content_type)::text else artifact_content_type end,
    completed_at = case when sqlc.arg(completed_at_set)::boolean then sqlc.narg(completed_at)::timestamptz else completed_at end,
    deleted_at = case when sqlc.arg(deleted_at_set)::boolean then sqlc.narg(deleted_at)::timestamptz else deleted_at end,
    updated_at = now()
where tenant_id = sqlc.arg(tenant_id) and id = sqlc.arg(id)
returning *;

-- name: DeleteTenantTranscription :one
with cancelled as (
    update artifact_jobs
    set state = 'cancelled', error_code = 'transcript_deleted', error_detail = 'transcript tombstoned',
        lease_token_hash = null, lease_owner = null, lease_expires_at = null,
        terminal_at = now(), updated_at = now()
    where artifact_jobs.transcript_id = sqlc.arg(id) and state in ('pending', 'retryable', 'leased')
)
update transcriptions
set status = 'deleted', deleted_at = now(), updated_at = now()
where transcriptions.tenant_id = sqlc.arg(tenant_id) and transcriptions.id = sqlc.arg(id)
returning *;

-- name: FinalizeTranscription :one
update transcriptions t
set status = 'complete',
    provider = sqlc.arg(provider), model = sqlc.arg(model), languages = sqlc.arg(languages),
    artifact_key = sqlc.arg(artifact_key),
    artifact_sha256 = sqlc.arg(artifact_sha256), artifact_size = sqlc.arg(artifact_size),
    artifact_content_type = sqlc.arg(artifact_content_type), completed_at = now(), updated_at = now()
where t.id = sqlc.arg(id) and t.status in ('preparing', 'transcribing', 'verifying')
  and exists (select 1 from transcript_chunks c where c.transcript_id = t.id)
  and not exists (select 1 from artifact_jobs j where j.transcript_id = t.id and j.artifact_kind = 'transcription_chunk' and j.state <> 'completed')
returning t.*;

-- name: CreateTranscriptChunk :one
insert into transcript_chunks (
    id, transcript_id, tenant_id, chunk_index, generation, start_ms, end_ms,
    participant_ref, track_epoch, identity_kind, track_class, storage_key, result_key, checksum, size, content_type
) values (
    sqlc.arg(id), sqlc.arg(transcript_id), sqlc.arg(tenant_id), sqlc.arg(chunk_index),
    sqlc.arg(generation), sqlc.arg(start_ms), sqlc.arg(end_ms), sqlc.narg(participant_ref),
    sqlc.narg(track_epoch), sqlc.arg(identity_kind), sqlc.arg(track_class), sqlc.arg(storage_key), sqlc.arg(result_key), sqlc.arg(checksum), sqlc.arg(size),
    sqlc.arg(content_type)
)
returning *;

-- name: ListTranscriptChunks :many
select * from transcript_chunks
where transcript_id = sqlc.arg(transcript_id) and generation = sqlc.arg(generation)
order by chunk_index asc;

-- name: GetTranscriptChunk :one
select * from transcript_chunks where id = sqlc.arg(id);

-- name: CreateTranscriptionAttempt :one
insert into transcription_attempts (
    id, transcript_id, chunk_id, generation, attempt, provider, model,
    provider_version, execution_identity, provider_request_id, measured_audio_ms, provider_observed_duration_ms,
    state, billed_audio_seconds, error_code, error_detail, journey_id, traceparent, tracestate, quality
) values (
    sqlc.arg(id), sqlc.arg(transcript_id), sqlc.arg(chunk_id), sqlc.arg(generation),
    sqlc.arg(attempt), sqlc.arg(provider), sqlc.arg(model), sqlc.arg(provider_version), sqlc.narg(execution_identity), sqlc.narg(provider_request_id), sqlc.narg(measured_audio_ms), sqlc.narg(provider_observed_duration_ms),
    sqlc.arg(state), sqlc.narg(billed_audio_seconds), sqlc.narg(error_code),
    sqlc.narg(error_detail), sqlc.narg(journey_id), sqlc.narg(traceparent), sqlc.narg(tracestate), sqlc.arg(quality)
)
returning *;

-- name: FinishTranscriptionAttempt :one
update transcription_attempts set state = sqlc.arg(state), error_code = sqlc.narg(error_code),
    error_detail = sqlc.narg(error_detail), billed_audio_seconds = sqlc.narg(billed_audio_seconds),
    execution_identity = coalesce(sqlc.narg(execution_identity)::text, execution_identity),
    provider_request_id = coalesce(sqlc.narg(provider_request_id)::text, provider_request_id),
    measured_audio_ms = coalesce(sqlc.narg(measured_audio_ms)::bigint, measured_audio_ms),
    provider_observed_duration_ms = coalesce(sqlc.narg(provider_observed_duration_ms)::bigint, provider_observed_duration_ms),
    quality = coalesce(sqlc.narg(quality)::jsonb, quality),
    finished_at = now()
where id = sqlc.arg(id) and state = 'started'
returning *;

-- name: AcceptTranscriptionChunkResult :one
insert into transcription_chunk_results (
    id, chunk_id, generation, attempt_id, provider, model, provider_version,
    result_key, result_sha256, result_size, result_content_type, language,
    billed_audio_seconds, quality
) values (
    sqlc.arg(id), sqlc.arg(chunk_id), sqlc.arg(generation), sqlc.arg(attempt_id),
    sqlc.arg(provider), sqlc.arg(model), sqlc.arg(provider_version), sqlc.arg(result_key),
    sqlc.arg(result_sha256), sqlc.arg(result_size), sqlc.arg(result_content_type),
    sqlc.narg(language), sqlc.narg(billed_audio_seconds), sqlc.arg(quality)
)
on conflict (chunk_id, generation) do nothing
returning *;

-- name: GetTranscriptChunkResult :one
select * from transcription_chunk_results
where chunk_id = sqlc.arg(chunk_id) and generation = sqlc.arg(generation);
