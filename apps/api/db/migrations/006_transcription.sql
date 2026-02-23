-- 006_transcription.sql
-- Transcription support for Chalk video conferencing

-- Transcripts table for storing meeting transcriptions
CREATE TABLE IF NOT EXISTS transcripts (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    participant_id UUID REFERENCES participants(id) ON DELETE SET NULL,
    cloudflare_participant_id VARCHAR(255),
    speaker_name VARCHAR(255) NOT NULL,
    text TEXT NOT NULL,
    confidence REAL,
    language VARCHAR(10),
    external_id VARCHAR(255),
    timestamp TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_transcripts_room_id ON transcripts(room_id);
CREATE INDEX IF NOT EXISTS idx_transcripts_room_timestamp ON transcripts(room_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_transcripts_external_id ON transcripts(external_id);

-- Add transcription defaults to existing tenants
UPDATE tenants SET tenant_config = tenant_config || '{
    "transcription_enabled": true,
    "transcription_language": "en-US",
    "transcription_profanity_filter": false,
    "transcription_keywords": []
}'::jsonb
WHERE NOT (tenant_config ? 'transcription_enabled');
