-- Participant Queries
-- CRUD operations and participant management

-- name: CreateParticipant :one
INSERT INTO participants (
    id,
    room_id,
    cloudflare_participant_id,
    external_user_id,
    display_name,
    role,
    joined_at,
    metadata
) VALUES (
    $1, $2, $3, $4, $5, $6, NOW(), $7
)
RETURNING *;

-- name: GetParticipant :one
SELECT * FROM participants
WHERE id = $1 LIMIT 1;

-- name: GetParticipantByCloudflareID :one
SELECT * FROM participants
WHERE cloudflare_participant_id = $1 LIMIT 1;

-- name: GetParticipantByExternalUserAndRoom :one
SELECT * FROM participants
WHERE room_id = $1 AND external_user_id = $2
ORDER BY created_at DESC
LIMIT 1;

-- name: ListParticipantsByRoom :many
SELECT * FROM participants
WHERE room_id = $1
ORDER BY joined_at ASC;

-- name: ListActiveParticipantsByRoom :many
SELECT * FROM participants
WHERE room_id = $1 AND left_at IS NULL
ORDER BY joined_at ASC;

-- name: CountActiveParticipantsByRoom :one
SELECT COUNT(*) FROM participants
WHERE room_id = $1 AND left_at IS NULL;

-- name: UpdateParticipant :one
UPDATE participants
SET
    display_name = COALESCE(sqlc.narg('display_name'), display_name),
    role = COALESCE(sqlc.narg('role'), role)
WHERE id = $1
RETURNING *;

-- name: ParticipantLeave :one
UPDATE participants
SET left_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ParticipantLeaveByCloudflareID :one
UPDATE participants
SET left_at = NOW()
WHERE cloudflare_participant_id = $1 AND left_at IS NULL
RETURNING *;

-- name: DeleteParticipant :exec
DELETE FROM participants
WHERE id = $1;

-- name: GetRoomHost :one
SELECT * FROM participants
WHERE room_id = $1 AND role = 'host' AND left_at IS NULL
ORDER BY joined_at ASC
LIMIT 1;

-- name: ListParticipantsWithRoomInfo :many
SELECT
    p.*,
    r.name as room_name,
    r.status as room_status
FROM participants p
JOIN rooms r ON r.id = p.room_id
WHERE p.external_user_id = $1
ORDER BY p.joined_at DESC
LIMIT $2 OFFSET $3;
