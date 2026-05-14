-- Audit Log Queries
-- Logging operations for compliance and debugging

-- name: CreateAuditLog :one
INSERT INTO audit_logs (
    tenant_id,
    room_id,
    actor_id,
    action,
    resource_type,
    resource_id,
    metadata,
    ip_address
) VALUES (
    $1, $2, $3, $4, $5, $6, $7, $8
)
RETURNING *;

-- name: GetAuditLog :one
SELECT * FROM audit_logs
WHERE id = $1 LIMIT 1;

-- name: ListAuditLogs :many
SELECT * FROM audit_logs
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListAuditLogsByTenant :many
SELECT * FROM audit_logs
WHERE tenant_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAuditLogsByRoom :many
SELECT * FROM audit_logs
WHERE room_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAuditLogsByActor :many
SELECT * FROM audit_logs
WHERE actor_id = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAuditLogsByAction :many
SELECT * FROM audit_logs
WHERE action = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAuditLogsByTenantAndAction :many
SELECT * FROM audit_logs
WHERE tenant_id = $1 AND action = $2
ORDER BY created_at DESC
LIMIT $3 OFFSET $4;

-- name: ListAuditLogsByTenantInDateRange :many
SELECT * FROM audit_logs
WHERE tenant_id = $1
  AND created_at >= $2
  AND created_at <= $3
ORDER BY created_at DESC
LIMIT $4 OFFSET $5;

-- name: ListAuditLogsByResourceType :many
SELECT * FROM audit_logs
WHERE resource_type = $1
ORDER BY created_at DESC
LIMIT $2 OFFSET $3;

-- name: ListAuditLogsByResource :many
SELECT * FROM audit_logs
WHERE resource_type = $1 AND resource_id = $2
ORDER BY created_at DESC
LIMIT $3 OFFSET $4;

-- name: CountAuditLogsByTenant :one
SELECT COUNT(*) FROM audit_logs
WHERE tenant_id = $1;

-- name: CountAuditLogsByAction :one
SELECT COUNT(*) FROM audit_logs
WHERE action = $1;

-- name: DeleteOldAuditLogs :exec
DELETE FROM audit_logs
WHERE created_at < $1;

-- name: GetAuditLogWithDetails :one
SELECT
    al.*,
    t.name as tenant_name,
    r.name as room_name
FROM audit_logs al
LEFT JOIN tenants t ON t.id = al.tenant_id
LEFT JOIN rooms r ON r.id = al.room_id
WHERE al.id = $1;
