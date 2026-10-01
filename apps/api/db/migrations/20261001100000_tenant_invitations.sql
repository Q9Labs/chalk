-- +goose Up
SET LOCAL lock_timeout = '5s';
-- The onboarding access ID is historical, not a reference to current access.
ALTER TABLE tenant_onboarding_requests DROP CONSTRAINT tenant_onboarding_requests_tenant_access_id_fkey;
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
-- Rollback is rejected if removed memberships are retained in onboarding history.
ALTER TABLE tenant_onboarding_requests ADD CONSTRAINT tenant_onboarding_requests_tenant_access_id_fkey FOREIGN KEY (tenant_access_id) REFERENCES memberships(id) DEFERRABLE INITIALLY DEFERRED;
