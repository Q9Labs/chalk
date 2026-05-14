-- Tenant Claims Queries
-- Pre-signup internal tenant claim (single-use)

-- name: CreateTenantClaim :one
INSERT INTO tenant_claims (
    tenant_id,
    secret_hash,
    expires_at
) VALUES (
    $1, $2, $3
)
RETURNING *;

-- name: GetTenantClaimBySecretHash :one
SELECT * FROM tenant_claims
WHERE secret_hash = $1
  AND used_at IS NULL
  AND expires_at > NOW()
LIMIT 1;

-- name: MarkTenantClaimUsed :one
UPDATE tenant_claims
SET used_at = NOW()
WHERE id = $1
RETURNING *;

