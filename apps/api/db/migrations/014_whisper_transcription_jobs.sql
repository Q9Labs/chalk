-- 014_whisper_transcription_jobs.sql
-- Durable history for self-hosted Whisper jobs queued through Redis.

CREATE TABLE IF NOT EXISTS whisper_transcription_jobs (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    transcript_id UUID NOT NULL REFERENCES post_meeting_transcripts(id) ON DELETE CASCADE,
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    provider VARCHAR(50) NOT NULL DEFAULT 'whisper',
    whisper_job_id UUID NOT NULL UNIQUE,
    queue_key TEXT NOT NULL,
    audio_storage_path TEXT NOT NULL,
    traceparent TEXT,
    language_hint VARCHAR(32),
    status VARCHAR(50) NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'completed', 'failed', 'timed_out')),
    queue_depth_at_enqueue BIGINT,
    processing_queue_depth_at_enqueue BIGINT,
    queue_depth_at_timeout BIGINT,
    processing_queue_depth_at_timeout BIGINT,
    result_language VARCHAR(10),
    duration_seconds INT,
    word_count INT,
    error_message TEXT,
    error_class VARCHAR(100),
    error_stage VARCHAR(100),
    download_http_status INT,
    download_size_bytes BIGINT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_whisper_transcription_jobs_transcript_id
    ON whisper_transcription_jobs (transcript_id);

CREATE INDEX IF NOT EXISTS idx_whisper_transcription_jobs_recording_id
    ON whisper_transcription_jobs (recording_id);

CREATE INDEX IF NOT EXISTS idx_whisper_transcription_jobs_room_id
    ON whisper_transcription_jobs (room_id);

CREATE INDEX IF NOT EXISTS idx_whisper_transcription_jobs_status_created_at
    ON whisper_transcription_jobs (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_whisper_transcription_jobs_created_at
    ON whisper_transcription_jobs (created_at DESC);
