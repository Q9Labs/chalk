-- Whisper transcription job history

-- name: CreateWhisperTranscriptionJob :one
INSERT INTO whisper_transcription_jobs (
    transcript_id,
    recording_id,
    room_id,
    provider,
    whisper_job_id,
    queue_key,
    audio_storage_path,
    traceparent,
    language_hint,
    status,
    queue_depth_at_enqueue,
    processing_queue_depth_at_enqueue
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9, 'queued', $10, $11
)
RETURNING *;

-- name: MarkWhisperTranscriptionJobCompleted :exec
UPDATE whisper_transcription_jobs
SET
    status = 'completed',
    result_language = $2,
    duration_seconds = $3,
    word_count = $4,
    completed_at = NOW()
WHERE whisper_job_id = $1;

-- name: MarkWhisperTranscriptionJobFailed :exec
UPDATE whisper_transcription_jobs
SET
    status = 'failed',
    error_message = $2,
    error_class = $3,
    error_stage = $4,
    download_http_status = $5,
    download_size_bytes = $6,
    completed_at = NOW()
WHERE whisper_job_id = $1;

-- name: MarkWhisperTranscriptionJobTimedOut :exec
UPDATE whisper_transcription_jobs
SET
    status = 'timed_out',
    error_message = $2,
    queue_depth_at_timeout = $3,
    processing_queue_depth_at_timeout = $4,
    completed_at = NOW()
WHERE whisper_job_id = $1;

-- name: AdminListWhisperTranscriptionJobs :many
SELECT
    wtj.*,
    r.name AS room_name,
    t.name AS tenant_name
FROM whisper_transcription_jobs wtj
JOIN rooms r ON r.id = wtj.room_id
JOIN tenants t ON t.id = r.tenant_id
ORDER BY wtj.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminListWhisperTranscriptionJobsByWhisperJobIDs :many
SELECT
    wtj.*,
    r.name AS room_name,
    t.name AS tenant_name
FROM whisper_transcription_jobs wtj
JOIN rooms r ON r.id = wtj.room_id
JOIN tenants t ON t.id = r.tenant_id
WHERE wtj.whisper_job_id = ANY($1::uuid[])
ORDER BY wtj.created_at DESC;

-- name: AdminGetWhisperTranscriptionJobStats :one
SELECT
    COUNT(*) FILTER (WHERE status = 'queued')::bigint AS queued,
    COUNT(*) FILTER (WHERE status = 'completed')::bigint AS completed,
    COUNT(*) FILTER (WHERE status = 'failed')::bigint AS failed,
    COUNT(*) FILTER (WHERE status = 'timed_out')::bigint AS timed_out,
    COUNT(*)::bigint AS total
FROM whisper_transcription_jobs;
