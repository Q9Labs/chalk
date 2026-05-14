-- Post-Meeting Transcripts Queries
-- CRUD operations for post-meeting transcription

-- name: CreatePostMeetingTranscript :one
INSERT INTO post_meeting_transcripts (recording_id, room_id, provider, status)
VALUES ($1, $2, $3, 'pending')
RETURNING *;

-- name: GetPostMeetingTranscript :one
SELECT * FROM post_meeting_transcripts
WHERE id = $1 LIMIT 1;

-- name: GetPostMeetingTranscriptByRecordingID :one
SELECT * FROM post_meeting_transcripts
WHERE recording_id = $1 LIMIT 1;

-- name: UpdatePostMeetingTranscriptStatus :exec
UPDATE post_meeting_transcripts
SET status = $2, error_message = $3
WHERE id = $1;

-- name: UpdatePostMeetingTranscriptResult :exec
UPDATE post_meeting_transcripts
SET
    transcript_text = $2,
    transcript_json = $3,
    language = $4,
    duration_seconds = $5,
    word_count = $6,
    provider_job_id = COALESCE($7, provider_job_id),
    error_message = NULL,
    provider_error_code = NULL,
    provider_error_metadata = NULL,
    status = 'completed',
    completed_at = NOW()
WHERE id = $1;

-- name: UpdatePostMeetingTranscriptAI :exec
UPDATE post_meeting_transcripts
SET summary = $2, action_items = $3
WHERE id = $1;

-- name: GetPendingTranscripts :many
SELECT * FROM post_meeting_transcripts
WHERE status = 'pending'
ORDER BY created_at ASC
LIMIT $1;

-- name: GetProcessingTranscripts :many
SELECT * FROM post_meeting_transcripts
WHERE status = 'processing'
ORDER BY created_at ASC
LIMIT $1;

-- name: ListPostMeetingTranscriptsByRoom :many
SELECT * FROM post_meeting_transcripts
WHERE room_id = $1
ORDER BY created_at DESC;

-- name: MarkPostMeetingTranscriptProcessing :exec
UPDATE post_meeting_transcripts
SET status = 'processing',
    completed_at = NULL
WHERE id = $1;

-- name: MarkPostMeetingTranscriptFailed :exec
UPDATE post_meeting_transcripts
SET status = 'failed',
    error_message = $2,
    provider_error_code = NULL,
    provider_error_metadata = NULL,
    completed_at = NOW()
WHERE id = $1;

-- name: MarkPostMeetingTranscriptDispatched :exec
UPDATE post_meeting_transcripts
SET status = 'processing',
    provider_job_id = COALESCE($2, provider_job_id),
    error_message = NULL,
    provider_error_code = NULL,
    provider_error_metadata = NULL,
    completed_at = NULL,
    dispatched_at = NOW()
WHERE id = $1;

-- name: MarkPostMeetingTranscriptFailedDetailed :exec
UPDATE post_meeting_transcripts
SET status = 'failed',
    error_message = $2,
    provider_error_code = $3,
    provider_error_metadata = $4,
    completed_at = NOW()
WHERE id = $1;
