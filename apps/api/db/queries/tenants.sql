-- Tenant Queries
-- CRUD operations and tenant-specific queries

-- name: CreateTenant :one
INSERT INTO tenants (
    name,
    api_key_hash,
    config,
    max_concurrent_rooms,
    max_participants_per_room,
    max_recording_duration_minutes
) VALUES (
    $1, $2, $3, $4, $5, $6
)
RETURNING *;

-- name: GetTenant :one
SELECT * FROM tenants
WHERE id = $1 LIMIT 1;

-- name: GetTenantByAPIKeyHash :one
SELECT * FROM tenants
WHERE api_key_hash = $1 AND is_active = true
LIMIT 1;

-- name: ListTenants :many
SELECT * FROM tenants
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListActiveTenants :many
SELECT * FROM tenants
WHERE is_active = true
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: ListActiveTenantAPIKeys :many
-- Minimal rowset for API key verification; avoid pulling large JSON configs for every tenant.
SELECT id, api_key_hash
FROM tenants
WHERE is_active = true
ORDER BY created_at DESC
LIMIT $1 OFFSET $2;

-- name: UpdateTenant :one
UPDATE tenants
SET
    name = COALESCE(sqlc.narg('name'), name),
    config = COALESCE(sqlc.narg('config'), config),
    max_concurrent_rooms = COALESCE(sqlc.narg('max_concurrent_rooms'), max_concurrent_rooms),
    max_participants_per_room = COALESCE(sqlc.narg('max_participants_per_room'), max_participants_per_room),
    max_recording_duration_minutes = COALESCE(sqlc.narg('max_recording_duration_minutes'), max_recording_duration_minutes)
WHERE id = $1
RETURNING *;

-- name: DeactivateTenant :one
UPDATE tenants
SET is_active = false
WHERE id = $1
RETURNING *;

-- name: ActivateTenant :one
UPDATE tenants
SET is_active = true
WHERE id = $1
RETURNING *;

-- name: DeleteTenant :exec
DELETE FROM tenants
WHERE id = $1;

-- name: CountTenants :one
SELECT COUNT(*) FROM tenants;

-- name: CountActiveTenants :one
SELECT COUNT(*) FROM tenants
WHERE is_active = true;

-- name: RotateTenantAPIKey :one
UPDATE tenants
SET api_key_hash = $2
WHERE id = $1
RETURNING *;

-- name: UpdateTenantConfig :one
UPDATE tenants
SET tenant_config = $2
WHERE id = $1
RETURNING *;

-- name: GetAllTenantAllowedOrigins :many
-- Returns all allowed_origins from active tenants' tenant_config JSONB
SELECT DISTINCT jsonb_array_elements_text(tenant_config->'allowed_origins') AS origin
FROM tenants
WHERE is_active = true
  AND tenant_config->'allowed_origins' IS NOT NULL
  AND jsonb_array_length(tenant_config->'allowed_origins') > 0;

-- name: GetTenantByRoomID :one
SELECT t.* FROM tenants t
JOIN rooms r ON r.tenant_id = t.id
WHERE r.id = $1
LIMIT 1;
