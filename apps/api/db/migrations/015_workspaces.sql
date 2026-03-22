-- MIGRATION 015: First-party workspaces under a shared internal tenant

CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    owner_user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'personal',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_tenant_owner_kind_unique
    ON workspaces(tenant_id, owner_user_id, kind)
    WHERE owner_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_workspaces_tenant_created_at
    ON workspaces(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspaces_owner_user_id
    ON workspaces(owner_user_id);

DROP TRIGGER IF EXISTS update_workspaces_updated_at ON workspaces;
CREATE TRIGGER update_workspaces_updated_at
    BEFORE UPDATE ON workspaces
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL DEFAULT 'member',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_memberships_user_id
    ON workspace_memberships(user_id, created_at DESC);

ALTER TABLE rooms
    ADD COLUMN IF NOT EXISTS workspace_id UUID,
    ADD COLUMN IF NOT EXISTS created_by_user_id UUID;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_workspace_id_fkey') THEN
        ALTER TABLE rooms
            ADD CONSTRAINT rooms_workspace_id_fkey
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE SET NULL;
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'rooms_created_by_user_id_fkey') THEN
        ALTER TABLE rooms
            ADD CONSTRAINT rooms_created_by_user_id_fkey
            FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE SET NULL;
    END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_rooms_workspace_created_at
    ON rooms(workspace_id, created_at DESC)
    WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rooms_workspace_status_created_at
    ON rooms(workspace_id, status, created_at DESC)
    WHERE workspace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rooms_created_by_user_id
    ON rooms(created_by_user_id)
    WHERE created_by_user_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_internal_shared_first_party_unique
    ON tenants(name)
    WHERE tenant_kind = 'internal'
      AND owner_user_id IS NULL
      AND name = 'Chalk First Party';

DO $$
DECLARE
    shared_tenant_id UUID;
BEGIN
    SELECT id
    INTO shared_tenant_id
    FROM tenants
    WHERE tenant_kind = 'internal'
      AND owner_user_id IS NULL
      AND name = 'Chalk First Party'
    ORDER BY created_at ASC
    LIMIT 1;

    IF shared_tenant_id IS NULL THEN
        INSERT INTO tenants (
            name,
            api_key_hash,
            config,
            max_concurrent_rooms,
            max_participants_per_room,
            max_recording_duration_minutes,
            tenant_kind,
            tenant_config
        ) VALUES (
            'Chalk First Party',
            'internal_shared_' || replace(chalk_uuid_v4()::text, '-', ''),
            '{}'::jsonb,
            100,
            10,
            120,
            'internal',
            '{"force_recording":true,"recording_retention_days":7,"allow_early_join":true,"transcription_enabled":true}'::jsonb
        )
        RETURNING id INTO shared_tenant_id;
    END IF;

    INSERT INTO workspaces (tenant_id, owner_user_id, name, kind)
    SELECT
        shared_tenant_id,
        u.id,
        'Personal Workspace',
        'personal'
    FROM users u
    WHERE NOT EXISTS (
        SELECT 1
        FROM workspaces w
        WHERE w.tenant_id = shared_tenant_id
          AND w.owner_user_id = u.id
          AND w.kind = 'personal'
    );

    INSERT INTO workspace_memberships (workspace_id, user_id, role)
    SELECT
        w.id,
        w.owner_user_id,
        'owner'
    FROM workspaces w
    WHERE w.owner_user_id IS NOT NULL
      AND NOT EXISTS (
          SELECT 1
          FROM workspace_memberships wm
          WHERE wm.workspace_id = w.id
            AND wm.user_id = w.owner_user_id
      );

    UPDATE rooms r
    SET
        tenant_id = shared_tenant_id,
        workspace_id = w.id,
        created_by_user_id = COALESCE(r.created_by_user_id, w.owner_user_id)
    FROM tenants t
    JOIN workspaces w
      ON w.owner_user_id = t.owner_user_id
     AND w.tenant_id = shared_tenant_id
     AND w.kind = 'personal'
    WHERE r.tenant_id = t.id
      AND t.tenant_kind = 'internal'
      AND t.owner_user_id IS NOT NULL;
END$$;
