-- 010_join_hot_path_indexes.sql
-- Composite indexes to speed common room/participant join-path lookups.

CREATE INDEX IF NOT EXISTS idx_rooms_tenant_name_created_at
    ON rooms (tenant_id, name, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_participants_room_external_user_created_at
    ON participants (room_id, external_user_id, created_at DESC);
