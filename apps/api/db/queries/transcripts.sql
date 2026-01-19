-- Transcript Queries
-- CRUD operations for meeting transcriptions

-- name: CreateTranscript :one
INSERT INTO transcripts (
    room_id,
    participant_id,
    cloudflare_participant_id,
    speaker_name,
    text,
    confidence,
    language,
    external_id,
    timestamp
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8, $9
)
RETURNING *;

-- name: GetTranscript :one
SELECT * FROM transcripts
WHERE id = $1 LIMIT 1;

-- name: GetTranscriptByExternalID :one
SELECT * FROM transcripts
WHERE external_id = $1 LIMIT 1;

-- name: ListTranscriptsByRoom :many
SELECT * FROM transcripts
WHERE room_id = $1
ORDER BY timestamp ASC
LIMIT $2 OFFSET $3;

-- name: CountTranscriptsByRoom :one
SELECT COUNT(*)::bigint FROM transcripts
WHERE room_id = $1;

-- name: DeleteTranscriptsByRoom :exec
DELETE FROM transcripts
WHERE room_id = $1;
