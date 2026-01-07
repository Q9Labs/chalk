-- 002_whiteboard.sql
-- Chalk Video Conferencing Platform - Whiteboard Feature

-- ============================================================================
-- ROOMS TABLE EXTENSIONS
-- Add whiteboard state storage
-- ============================================================================

-- Add whiteboard state column to rooms table
-- Stores the Excalidraw state JSON (elements, files, appState)
ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS whiteboard_state JSONB;

COMMENT ON COLUMN rooms.whiteboard_state IS 'Excalidraw state JSON (elements, files, appState)';

-- Index for rooms with active whiteboards (for querying rooms with whiteboard data)
CREATE INDEX IF NOT EXISTS idx_rooms_whiteboard_state
ON rooms USING GIN (whiteboard_state)
WHERE whiteboard_state IS NOT NULL;

-- ============================================================================
-- TENANTS TABLE EXTENSIONS
-- Add whiteboard configuration
-- ============================================================================

-- Add whiteboard config column to tenants table
-- Configures default access and host override capabilities
-- default_access: "all" (everyone can draw), "host_only" (only host), "none" (whiteboard disabled)
-- host_can_override: whether host can grant/revoke individual permissions
ALTER TABLE tenants
ADD COLUMN IF NOT EXISTS whiteboard_config JSONB DEFAULT '{"default_access": "all", "host_can_override": true}';

COMMENT ON COLUMN tenants.whiteboard_config IS 'Whiteboard permission config: default_access (all/host_only/none), host_can_override (boolean)';

-- ============================================================================
-- WHITEBOARD PERMISSIONS TABLE (optional - for persistent per-participant permissions)
-- Can be used for rooms that need to persist whiteboard permissions across reconnects
-- ============================================================================

CREATE TABLE IF NOT EXISTS whiteboard_permissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    can_draw BOOLEAN NOT NULL DEFAULT true,
    granted_by UUID REFERENCES participants(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(room_id, participant_id)
);

DROP TRIGGER IF EXISTS update_whiteboard_permissions_updated_at ON whiteboard_permissions;
CREATE TRIGGER update_whiteboard_permissions_updated_at
    BEFORE UPDATE ON whiteboard_permissions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Indexes for whiteboard_permissions
CREATE INDEX IF NOT EXISTS idx_whiteboard_permissions_room_id ON whiteboard_permissions(room_id);
CREATE INDEX IF NOT EXISTS idx_whiteboard_permissions_participant_id ON whiteboard_permissions(participant_id);
