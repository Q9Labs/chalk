-- API-HIGH-06: Add 'failed' status to recordings
-- The recording service sets 'failed' status but the constraint didn't include it

-- Drop the existing inline constraint and add a new one with 'failed'
ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_status_check;

ALTER TABLE recordings ADD CONSTRAINT recordings_status_check
  CHECK (status IN ('recording', 'processing', 'ready', 'archived', 'deleted', 'failed'));
