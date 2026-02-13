-- 008_internal_tenant_users.sql
-- Internal tenants (Chalk-owned clients) + end-user auth primitives.
--
-- Goal: support Chalk first-party apps (web/mobile) without shipping tenant API keys to clients.
-- Model:
-- - tenants.tenant_kind: external (API customers) | internal (Chalk-owned apps)
-- - users: end-user identity (email)
-- - user_sessions: refresh sessions for cross-device login
-- - tenant_claims: allow "no-signup meeting" -> later claim to an email/user

-- ============================================================================
-- USERS
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Case-insensitive uniqueness by convention (store lower(email) at write time too)
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique ON users (lower(email));

DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- USER SESSIONS (refresh token stored hashed)
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_token_hash ON user_sessions(refresh_token_hash);

-- ============================================================================
-- TENANTS: INTERNAL/EXTERNAL + OWNER BINDING
-- ============================================================================
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_kind TEXT NOT NULL DEFAULT 'external';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_user_id UUID;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tenant_kind_check') THEN
        ALTER TABLE tenants
            ADD CONSTRAINT tenants_tenant_kind_check
            CHECK (tenant_kind IN ('external', 'internal'));
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_owner_user_id_fkey') THEN
        ALTER TABLE tenants
            ADD CONSTRAINT tenants_owner_user_id_fkey
            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END$$;

-- Hard 1:1 for internal tenants: one user -> one internal tenant
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_internal_owner_user_id_unique
    ON tenants(owner_user_id)
    WHERE tenant_kind = 'internal' AND owner_user_id IS NOT NULL;

-- ============================================================================
-- TENANT CLAIMS (pre-signup workspace claim)
-- ============================================================================
CREATE TABLE IF NOT EXISTS tenant_claims (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_claims_tenant_id ON tenant_claims(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_claims_expires_at ON tenant_claims(expires_at);
CREATE INDEX IF NOT EXISTS idx_tenant_claims_secret_hash ON tenant_claims(secret_hash);

