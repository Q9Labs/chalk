-- Internal Meetings Queries
-- Dashboard rows (room + recording + transcript summary)

-- name: ListMeetingsByTenant :many
SELECT
    rec.*,
    r.name AS room_name,
    r.status AS room_status,
    r.started_at AS room_started_at,
    r.ended_at AS room_ended_at,
    r.metadata AS room_metadata,
    pmt.id AS transcript_id,
    pmt.status AS transcript_status,
    pmt.created_at AS transcript_created_at,
    pmt.completed_at AS transcript_completed_at,
    pmt.language AS transcript_language,
    pmt.duration_seconds AS transcript_duration_seconds,
    pmt.word_count AS transcript_word_count,
    pmt.provider AS transcript_provider,
    pmt.summary AS transcript_summary,
    pmt.action_items AS transcript_action_items,
    pmt.error_message AS transcript_error_message
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
LEFT JOIN post_meeting_transcripts pmt ON pmt.recording_id = rec.id
WHERE r.tenant_id = $1
ORDER BY rec.created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountMeetingsByTenant :one
SELECT COUNT(*)::bigint FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
WHERE r.tenant_id = $1;

-- name: ListMeetingsByWorkspace :many
SELECT
    rec.*,
    r.name AS room_name,
    r.status AS room_status,
    r.started_at AS room_started_at,
    r.ended_at AS room_ended_at,
    r.metadata AS room_metadata,
    pmt.id AS transcript_id,
    pmt.status AS transcript_status,
    pmt.created_at AS transcript_created_at,
    pmt.completed_at AS transcript_completed_at,
    pmt.language AS transcript_language,
    pmt.duration_seconds AS transcript_duration_seconds,
    pmt.word_count AS transcript_word_count,
    pmt.provider AS transcript_provider,
    pmt.summary AS transcript_summary,
    pmt.action_items AS transcript_action_items,
    pmt.error_message AS transcript_error_message
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
LEFT JOIN post_meeting_transcripts pmt ON pmt.recording_id = rec.id
WHERE r.workspace_id = $1
ORDER BY rec.created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountMeetingsByWorkspace :one
SELECT COUNT(*)::bigint FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
WHERE r.workspace_id = $1;
