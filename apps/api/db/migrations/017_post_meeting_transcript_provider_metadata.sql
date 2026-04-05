-- 017_post_meeting_transcript_provider_metadata.sql
-- Add provider job/error metadata for async Cloudflare transcription callbacks

ALTER TABLE post_meeting_transcripts
    ADD COLUMN IF NOT EXISTS provider_job_id TEXT;

ALTER TABLE post_meeting_transcripts
    ADD COLUMN IF NOT EXISTS provider_error_code TEXT;

ALTER TABLE post_meeting_transcripts
    ADD COLUMN IF NOT EXISTS provider_error_metadata JSONB;

ALTER TABLE post_meeting_transcripts
    ADD COLUMN IF NOT EXISTS dispatched_at TIMESTAMPTZ;
