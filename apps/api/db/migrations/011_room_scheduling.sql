-- 011_room_scheduling.sql
-- Add first-class room scheduling support

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS allow_early_join_minutes INT NOT NULL DEFAULT 0;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_status_check;
ALTER TABLE rooms
  ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('scheduled', 'active', 'ended'));

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_allow_early_join_minutes_nonnegative;
ALTER TABLE rooms
  ADD CONSTRAINT rooms_allow_early_join_minutes_nonnegative
  CHECK (allow_early_join_minutes >= 0);

CREATE INDEX IF NOT EXISTS idx_rooms_tenant_scheduled_start
  ON rooms(tenant_id, scheduled_start_at DESC)
  WHERE status = 'scheduled';
