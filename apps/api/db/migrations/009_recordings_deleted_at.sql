-- 009_recordings_deleted_at.sql
-- Keep internal meeting history while hard-deleting the underlying recording file.
-- We tombstone a recording by clearing storage fields + setting status='deleted' + deleted_at.

ALTER TABLE recordings
ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_recordings_deleted_at ON recordings(deleted_at);

