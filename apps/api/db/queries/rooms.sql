-- Room Queries
-- CRUD operations and room management

-- name: CreateRoom :one
INSERT INTO rooms (
    tenant_id,
    cloudflare_meeting_id,
    name,
    config,
    started_at
) VALUES (
    $1, $2, $3, $4, NOW()
)
RETURNING *;

-- name: CreateRoomWithID :one
INSERT INTO rooms (
    id,
    tenant_id,
    cloudflare_meeting_id,
    name,
    config,
    started_at
) VALUES (
    $1, $2, $3, $4, $5, NOW()
)
RETURNING *;

-- name: GetRoom :one
SELECT * FROM rooms
WHERE id = $1 LIMIT 1;

-- name: GetRoomByCloudflareID :one
SELECT * FROM rooms
WHERE cloudflare_meeting_id = $1 LIMIT 1;

-- name: ListRooms :many
SELECT * FROM rooms
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListRoomsByTenant :many
SELECT * FROM rooms
WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListActiveRoomsByTenant :many
SELECT * FROM rooms
WHERE tenant_id = $1 AND status = 'active'
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: CountActiveRoomsByTenant :one
SELECT COUNT(*) FROM rooms
WHERE tenant_id = $1 AND status = 'active';

-- name: UpdateRoom :one
UPDATE rooms
SET
    name = COALESCE(sqlc.narg('name'), name),
    config = COALESCE(sqlc.narg('config'), config)
WHERE id = $1
RETURNING *;

-- name: EndRoom :one
UPDATE rooms
SET
    status = 'ended',
    ended_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ReactivateRoom :one
UPDATE rooms
SET
    status = 'active',
    cloudflare_meeting_id = $2,
    started_at = NOW(),
    ended_at = NULL
WHERE id = $1
RETURNING *;

-- name: DeleteRoom :exec
DELETE FROM rooms
WHERE id = $1;

-- name: GetRoomWithParticipantCount :one
SELECT
    r.*,
    COUNT(p.id) FILTER (WHERE p.left_at IS NULL) as active_participant_count
FROM rooms r
LEFT JOIN participants p ON p.room_id = r.id
WHERE r.id = $1
GROUP BY r.id;

-- name: ListActiveRoomsWithParticipantCount :many
SELECT
    r.*,
    COUNT(p.id) FILTER (WHERE p.left_at IS NULL) as active_participant_count
FROM rooms r
LEFT JOIN participants p ON p.room_id = r.id
WHERE r.tenant_id = $1 AND r.status = 'active'
GROUP BY r.id
ORDER BY r.created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListEmptyActiveRooms :many
SELECT r.* FROM rooms r
LEFT JOIN participants p ON p.room_id = r.id AND p.left_at IS NULL
WHERE r.status = 'active'
  AND r.created_at < NOW() - INTERVAL '1 minute' * $1
GROUP BY r.id
HAVING COUNT(p.id) = 0;

-- name: GetRoomByNameAndTenant :one
SELECT * FROM rooms
WHERE name = $1 AND tenant_id = $2
ORDER BY created_at DESC
LIMIT 1;
