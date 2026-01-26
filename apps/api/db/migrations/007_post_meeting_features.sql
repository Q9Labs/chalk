-- 007_post_meeting_features.sql
-- Post-meeting transcription and webhook delivery support

-- ============================================================================
-- POST-MEETING TRANSCRIPTS TABLE
-- Stores full transcripts generated from recordings (via Groq/Whisper)
-- ============================================================================
CREATE TABLE IF NOT EXISTS post_meeting_transcripts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    transcript_text TEXT,
    transcript_json JSONB,  -- timestamps, speakers, segments
    language VARCHAR(10),
    duration_seconds INT,
    word_count INT,
    provider VARCHAR(50),  -- groq, whisper
    summary TEXT,
    action_items TEXT[],
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_post_meeting_transcripts_recording_id ON post_meeting_transcripts(recording_id);
CREATE INDEX IF NOT EXISTS idx_post_meeting_transcripts_room_id ON post_meeting_transcripts(room_id);
CREATE INDEX IF NOT EXISTS idx_post_meeting_transcripts_status ON post_meeting_transcripts(status);

-- ============================================================================
-- WEBHOOK DELIVERIES TABLE
-- Tracks webhook delivery attempts with retry support
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
    transcript_id UUID REFERENCES post_meeting_transcripts(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,  -- 'meeting.recording_ready', 'meeting.transcript_ready'
    webhook_url TEXT NOT NULL,
    payload JSONB NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'delivered', 'failed')),
    attempts INT NOT NULL DEFAULT 0,
    max_attempts INT NOT NULL DEFAULT 5,
    last_error TEXT,
    next_retry_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant_id ON webhook_deliveries(tenant_id);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_status ON webhook_deliveries(status);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_next_retry ON webhook_deliveries(next_retry_at) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_room_id ON webhook_deliveries(room_id);
