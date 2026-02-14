-- Recording Queries
-- CRUD operations and recording management

-- name: CreateRecording :one
INSERT INTO recordings (
    room_id,
    cloudflare_recording_id,
    status,
    started_at
) VALUES (
    $1, $2, 'recording', NOW()
)
RETURNING *;

-- name: GetRecording :one
SELECT * FROM recordings
WHERE id = $1 LIMIT 1;

-- name: GetRecordingByCloudflareID :one
SELECT * FROM recordings
WHERE cloudflare_recording_id = $1 LIMIT 1;

-- name: GetActiveRecordingByRoom :one
SELECT * FROM recordings
WHERE room_id = $1 AND status = 'recording'
LIMIT 1;

-- name: ListRecordings :many
SELECT * FROM recordings
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListRecordingsByRoom :many
SELECT * FROM recordings
WHERE room_id = $1
ORDER BY created_at DESC;

-- name: ListRecordingsByStatus :many
SELECT * FROM recordings
WHERE status = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListRecordingsReadyForArchive :many
SELECT rec.* FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
JOIN tenants t ON t.id = r.tenant_id
WHERE rec.status = 'ready'
  AND rec.archived_at IS NULL
  AND rec.ended_at < NOW() - INTERVAL '7 days'
  AND t.tenant_kind != 'internal'
ORDER BY rec.ended_at ASC
LIMIT $1;

-- name: StopRecording :one
UPDATE recordings
SET
    status = 'processing',
    ended_at = NOW()
WHERE id = $1
RETURNING *;

-- name: CompleteRecording :one
UPDATE recordings
SET
    status = 'ready',
    storage_provider = $2,
    storage_path = $3,
    size_bytes = $4,
    duration_seconds = $5
WHERE id = $1
RETURNING *;

-- name: ArchiveRecording :one
UPDATE recordings
SET
    status = 'archived',
    storage_provider = 's3_glacier',
    archived_at = NOW()
WHERE id = $1
RETURNING *;

-- name: ArchiveRecordingWithPath :one
UPDATE recordings
SET
    status = 'archived',
    storage_provider = 's3_glacier',
    storage_path = $2,
    archived_at = NOW()
WHERE id = $1
RETURNING *;

-- name: MarkRecordingDeleted :one
UPDATE recordings
SET
    status = 'deleted',
    deleted_at = NOW(),
    -- Keep metadata (duration/size) but remove storage pointers once the file is gone.
    storage_provider = NULL,
    storage_path = NULL
WHERE id = $1
RETURNING *;

-- name: DeleteRecording :exec
DELETE FROM recordings
WHERE id = $1;

-- name: GetRecordingWithRoomInfo :one
SELECT
    rec.*,
    r.name as room_name,
    r.tenant_id
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
WHERE rec.id = $1;

-- name: ListRecordingsByTenant :many
SELECT
    rec.*,
    r.name as room_name
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
WHERE r.tenant_id = $1
ORDER BY rec.created_at DESC
LIMIT $2 OFFSET $3;

-- name: GetTotalRecordingStorageByTenant :one
SELECT COALESCE(SUM(rec.size_bytes), 0)::bigint as total_bytes
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
WHERE r.tenant_id = $1 AND rec.status IN ('ready', 'archived');

-- name: MarkRecordingFailed :one
UPDATE recordings SET status = 'failed' WHERE id = $1 RETURNING *;
