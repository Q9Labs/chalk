-- 013_screen_annotations.sql
-- Chalk Video Conferencing Platform - Screen Annotations

ALTER TABLE rooms
ADD COLUMN IF NOT EXISTS screen_annotation_state JSONB;

COMMENT ON COLUMN rooms.screen_annotation_state IS 'Screen annotation state JSON (share session, items, access mode)';

CREATE INDEX IF NOT EXISTS idx_rooms_screen_annotation_state
ON rooms USING GIN (screen_annotation_state)
WHERE screen_annotation_state IS NOT NULL;
