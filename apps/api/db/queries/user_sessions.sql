-- User Sessions Queries
-- Refresh sessions stored as hashed tokens

-- name: CreateUserSession :one
INSERT INTO user_sessions (
    user_id,
    refresh_token_hash,
    expires_at,
    ip_address,
    user_agent
) VALUES (
    $1, $2, $3, $4, $5
)
RETURNING *;

-- name: GetUserSessionByRefreshTokenHash :one
SELECT * FROM user_sessions
WHERE refresh_token_hash = $1
  AND revoked_at IS NULL
  AND expires_at > NOW()
LIMIT 1;

-- name: TouchUserSession :exec
UPDATE user_sessions
SET last_used_at = NOW()
WHERE id = $1;

-- name: RevokeUserSession :exec
UPDATE user_sessions
SET revoked_at = NOW()
WHERE id = $1;

