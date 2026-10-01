-- +goose Up
SET LOCAL lock_timeout = '5s';
CREATE TABLE tenant_invitations (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES tenants(id),
 email text NOT NULL,
 role text NOT NULL CHECK (role IN ('owner', 'collaborator', 'observer')),
 token_hash text NOT NULL UNIQUE,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),
 consumed_at timestamptz,
 revoked_at timestamptz
);
CREATE UNIQUE INDEX tenant_invitations_pending_email ON tenant_invitations(tenant_id,email) WHERE consumed_at IS NULL AND revoked_at IS NULL;
-- +goose Down
SET LOCAL lock_timeout = '5s';
DROP TABLE tenant_invitations;
