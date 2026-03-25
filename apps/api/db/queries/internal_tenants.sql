-- Internal Tenant Queries
-- Chalk-owned app workspaces (web + mobile)

-- name: CreateInternalTenant :one
INSERT INTO tenants (
    name,
    api_key_hash,
    api_key_lookup_hash,
    config,
    max_concurrent_rooms,
    max_participants_per_room,
    max_recording_duration_minutes,
    tenant_kind,
    owner_user_id,
    claimed_at,
    tenant_config
) VALUES (
    $1, $2, $3, $4, $5, $6, $7,
    'internal',
    $8,
    $9,
    $10
)
RETURNING *;

-- name: GetInternalTenantByOwnerUserID :one
SELECT * FROM tenants
WHERE tenant_kind = 'internal'
  AND owner_user_id = $1
LIMIT 1;

-- name: GetSharedInternalTenantByName :one
SELECT * FROM tenants
WHERE tenant_kind = 'internal'
  AND owner_user_id IS NULL
  AND name = $1
ORDER BY created_at ASC
LIMIT 1;

-- name: BindInternalTenantToOwner :one
UPDATE tenants
SET owner_user_id = $2,
    claimed_at = NOW()
WHERE id = $1
  AND tenant_kind = 'internal'
  AND owner_user_id IS NULL
RETURNING *;
