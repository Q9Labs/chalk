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
    pmt.completed_at AS transcript_completed_at
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

