-- Admin Queries
-- Cross-tenant queries for the admin dashboard

-- name: AdminGetOverview :one
SELECT
    (SELECT COUNT(*) FROM tenants WHERE is_active = true) AS active_tenants,
    (SELECT COUNT(*) FROM rooms WHERE status = 'active') AS active_rooms,
    (SELECT COUNT(*) FROM rooms) AS total_rooms,
    (SELECT COUNT(*) FROM recordings) AS total_recordings,
    (SELECT COALESCE(SUM(size_bytes), 0) FROM recordings WHERE status IN ('ready', 'archived')) AS total_storage_bytes,
    (SELECT COUNT(*) FROM participants WHERE left_at IS NULL) AS active_participants;

-- name: AdminListTenants :many
SELECT
    t.*,
    (SELECT COUNT(*) FROM rooms r WHERE r.tenant_id = t.id AND r.status = 'active') AS active_rooms,
    (SELECT COUNT(*) FROM rooms r WHERE r.tenant_id = t.id) AS total_rooms,
    (SELECT COUNT(*) FROM recordings rec JOIN rooms r ON r.id = rec.room_id WHERE r.tenant_id = t.id) AS total_recordings,
    (SELECT COALESCE(SUM(rec.size_bytes), 0) FROM recordings rec JOIN rooms r ON r.id = rec.room_id WHERE r.tenant_id = t.id AND rec.status IN ('ready', 'archived')) AS storage_bytes,
    (SELECT COUNT(*) FROM participants p JOIN rooms r ON r.id = p.room_id WHERE r.tenant_id = t.id) AS total_participants
FROM tenants t
ORDER BY t.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminListRooms :many
SELECT
    r.*,
    t.name AS tenant_name,
    (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id AND p.left_at IS NULL) AS active_participant_count
FROM rooms r
JOIN tenants t ON t.id = r.tenant_id
ORDER BY r.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminGetRoom :one
SELECT
    r.*,
    t.name AS tenant_name,
    (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id AND p.left_at IS NULL) AS active_participant_count
FROM rooms r
JOIN tenants t ON t.id = r.tenant_id
WHERE r.id = $1;

-- name: AdminListRoomParticipants :many
SELECT * FROM participants
WHERE room_id = $1
ORDER BY joined_at DESC;

-- name: AdminListRecordings :many
SELECT
    rec.*,
    r.name AS room_name,
    t.name AS tenant_name
FROM recordings rec
JOIN rooms r ON r.id = rec.room_id
JOIN tenants t ON t.id = r.tenant_id
ORDER BY rec.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminListTranscripts :many
SELECT
    pmt.*,
    r.name AS room_name,
    t.name AS tenant_name,
    rec.duration_seconds AS recording_duration_seconds
FROM post_meeting_transcripts pmt
JOIN rooms r ON r.id = pmt.room_id
JOIN recordings rec ON rec.id = pmt.recording_id
JOIN tenants t ON t.id = r.tenant_id
ORDER BY pmt.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminListWebhookDeliveries :many
SELECT
    wd.*,
    t.name AS tenant_name,
    r.name AS room_name
FROM webhook_deliveries wd
JOIN tenants t ON t.id = wd.tenant_id
JOIN rooms r ON r.id = wd.room_id
ORDER BY wd.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminGetWebhookStats :one
SELECT
    COUNT(*) FILTER (WHERE status = 'delivered') AS delivered,
    COUNT(*) FILTER (WHERE status = 'failed' AND attempts >= max_attempts) AS failed,
    COUNT(*) FILTER (WHERE status IN ('pending', 'sending')) AS pending,
    COUNT(*) AS total
FROM webhook_deliveries;

-- name: AdminListAuditLogs :many
SELECT
    al.*,
    t.name AS tenant_name,
    r.name AS room_name
FROM audit_logs al
LEFT JOIN tenants t ON t.id = al.tenant_id
LEFT JOIN rooms r ON r.id = al.room_id
ORDER BY al.created_at DESC
LIMIT $1 OFFSET $2;

-- name: AdminGetMeetingDurations :many
SELECT
    t.id AS tenant_id,
    t.name AS tenant_name,
    COALESCE(SUM(EXTRACT(EPOCH FROM (r.ended_at - r.started_at))), 0)::bigint AS total_duration_seconds
FROM tenants t
LEFT JOIN rooms r ON r.tenant_id = t.id AND r.ended_at IS NOT NULL
GROUP BY t.id, t.name
ORDER BY total_duration_seconds DESC;

-- name: AdminGetStorageByProvider :many
SELECT
    COALESCE(storage_provider, 'unknown') AS storage_provider,
    COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes,
    COUNT(*) AS recording_count
FROM recordings
WHERE status IN ('ready', 'archived')
GROUP BY storage_provider;

-- name: AdminUpdateWhiteboardConfig :one
UPDATE tenants
SET whiteboard_config = $2
WHERE id = $1
RETURNING *;
