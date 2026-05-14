-- Workspace Queries
-- First-party ownership + collaboration scope under a shared tenant

-- name: CreateWorkspace :one
INSERT INTO workspaces (
    tenant_id,
    owner_user_id,
    name,
    kind
) VALUES (
    $1, $2, $3, $4
)
RETURNING *;

-- name: GetWorkspace :one
SELECT * FROM workspaces
WHERE id = $1
LIMIT 1;

-- name: GetWorkspaceByTenantAndOwner :one
SELECT * FROM workspaces
WHERE tenant_id = $1
  AND owner_user_id = $2
  AND kind = $3
LIMIT 1;

-- name: CreateWorkspaceMembership :one
INSERT INTO workspace_memberships (
    workspace_id,
    user_id,
    role
) VALUES (
    $1, $2, $3
)
ON CONFLICT (workspace_id, user_id) DO UPDATE
SET role = EXCLUDED.role
RETURNING *;
