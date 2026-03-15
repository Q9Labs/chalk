package postgres

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Config holds the database configuration
type Config struct {
	Host              string
	Port              int
	User              string
	Password          string
	Database          string
	SSLMode           string
	MaxConns          int32
	MinConns          int32
	MaxConnLifetime   time.Duration
	MaxConnIdleTime   time.Duration
	HealthCheckPeriod time.Duration
}

// DefaultConfig returns a Config with sensible defaults
func DefaultConfig() Config {
	return Config{
		Host:              "localhost",
		Port:              5432,
		User:              "default_user",
		Password:          "default_password",
		Database:          "default_db",
		SSLMode:           "disable",
		MaxConns:          25,
		MinConns:          5,
		MaxConnLifetime:   time.Hour,
		MaxConnIdleTime:   30 * time.Minute,
		HealthCheckPeriod: time.Minute,
	}
}

// DSN returns the connection string for the database
func (c Config) DSN() string {
	// Only include password if non-empty (empty password= confuses pgx parser)
	if c.Password != "" {
		return fmt.Sprintf(
			"host=%s port=%d user=%s password=%s dbname=%s sslmode=%s",
			c.Host, c.Port, c.User, c.Password, c.Database, c.SSLMode,
		)
	}
	return fmt.Sprintf(
		"host=%s port=%d user=%s dbname=%s sslmode=%s",
		c.Host, c.Port, c.User, c.Database, c.SSLMode,
	)
}

// Pool wraps pgxpool.Pool with additional functionality
type Pool struct {
	*pgxpool.Pool
	config Config
}

// NewPool creates a new database connection pool
func NewPool(ctx context.Context, cfg Config) (*Pool, error) {
	poolConfig, err := pgxpool.ParseConfig(cfg.DSN())
	if err != nil {
		return nil, fmt.Errorf("failed to parse pool config: %w", err)
	}

	// Apply pool configuration
	poolConfig.MaxConns = cfg.MaxConns
	poolConfig.MinConns = cfg.MinConns
	poolConfig.MaxConnLifetime = cfg.MaxConnLifetime
	poolConfig.MaxConnIdleTime = cfg.MaxConnIdleTime
	poolConfig.HealthCheckPeriod = cfg.HealthCheckPeriod

	pool, err := pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		return nil, fmt.Errorf("failed to create connection pool: %w", err)
	}

	// Verify connection
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("failed to ping database: %w", err)
	}

	return &Pool{
		Pool:   pool,
		config: cfg,
	}, nil
}

// Health checks if the database connection is healthy
func (p *Pool) Health(ctx context.Context) error {
	return p.Ping(ctx)
}

// Stats returns the connection pool statistics
func (p *Pool) Stats() *pgxpool.Stat {
	return p.Stat()
}

// Close closes the connection pool
func (p *Pool) Close() {
	p.Pool.Close()
}

// RunMigrations executes the embedded database migrations
func (p *Pool) RunMigrations(ctx context.Context) error {
	// Initial schema migration - idempotent (uses IF NOT EXISTS)
	schema := `
-- UUID helper that works on managed Postgres without extension privileges.
CREATE OR REPLACE FUNCTION chalk_uuid_v4()
RETURNS UUID AS $$
    SELECT md5(random()::text || clock_timestamp()::text)::uuid;
$$ LANGUAGE sql VOLATILE;

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- TENANTS TABLE
CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    name VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(255) NOT NULL UNIQUE,
    config JSONB NOT NULL DEFAULT '{}',
    max_concurrent_rooms INT NOT NULL DEFAULT 100,
    max_participants_per_room INT NOT NULL DEFAULT 10,
    max_recording_duration_minutes INT NOT NULL DEFAULT 120,
    max_total_minutes_of_meetings INT NOT NULL DEFAULT 1000,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    whiteboard_config JSONB DEFAULT '{"default_access": "all", "host_can_override": true}',
    tenant_config JSONB NOT NULL DEFAULT '{"force_recording": false, "duplicate_participant_policy": "allow", "empty_room_timeout_minutes": 30, "recording_retention_days": 90, "auto_start_recording": false, "allow_early_join": true}'::jsonb
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS max_total_minutes_of_meetings INT NOT NULL DEFAULT 1000;

DROP TRIGGER IF EXISTS update_tenants_updated_at ON tenants;
CREATE TRIGGER update_tenants_updated_at
    BEFORE UPDATE ON tenants
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ROOMS TABLE
CREATE TABLE IF NOT EXISTS rooms (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    cloudflare_meeting_id VARCHAR(255) NOT NULL,
    name VARCHAR(255),
    config JSONB NOT NULL DEFAULT '{}',
    status VARCHAR(50) NOT NULL DEFAULT 'active' CHECK (status IN ('scheduled', 'active', 'ended')),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    scheduled_start_at TIMESTAMPTZ,
    scheduled_end_at TIMESTAMPTZ,
    allow_early_join_minutes INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    whiteboard_state JSONB,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DROP TRIGGER IF EXISTS update_rooms_updated_at ON rooms;
CREATE TRIGGER update_rooms_updated_at
    BEFORE UPDATE ON rooms
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_rooms_tenant_id ON rooms(tenant_id);
CREATE INDEX IF NOT EXISTS idx_rooms_status ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_status ON rooms(tenant_id, status);
CREATE INDEX IF NOT EXISTS idx_rooms_cloudflare_meeting_id ON rooms(cloudflare_meeting_id);
CREATE INDEX IF NOT EXISTS idx_rooms_created_at ON rooms(created_at DESC);

-- PARTICIPANTS TABLE
CREATE TABLE IF NOT EXISTS participants (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    cloudflare_participant_id VARCHAR(255) NOT NULL,
    external_user_id VARCHAR(255),
    display_name VARCHAR(255),
    role VARCHAR(50) NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
    joined_at TIMESTAMPTZ,
    left_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_participants_room_id ON participants(room_id);
CREATE INDEX IF NOT EXISTS idx_participants_external_user_id ON participants(external_user_id);
CREATE INDEX IF NOT EXISTS idx_participants_room_active ON participants(room_id) WHERE left_at IS NULL;

-- RECORDINGS TABLE
CREATE TABLE IF NOT EXISTS recordings (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    cloudflare_recording_id VARCHAR(255),
    storage_provider VARCHAR(50) CHECK (storage_provider IN ('r2', 's3_glacier')),
    storage_path VARCHAR(500),
    size_bytes BIGINT,
    duration_seconds INT,
    status VARCHAR(50) NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'processing', 'ready', 'archived', 'deleted')),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    archived_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_recordings_room_id ON recordings(room_id);
CREATE INDEX IF NOT EXISTS idx_recordings_status ON recordings(status);
CREATE INDEX IF NOT EXISTS idx_recordings_storage_provider ON recordings(storage_provider);
CREATE INDEX IF NOT EXISTS idx_recordings_archived_at ON recordings(archived_at) WHERE archived_at IS NULL;

-- AUDIT LOGS TABLE
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE SET NULL,
    room_id UUID REFERENCES rooms(id) ON DELETE SET NULL,
    actor_id VARCHAR(255),
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100),
    resource_id UUID,
    metadata JSONB,
    ip_address INET,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_id ON audit_logs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_room_id ON audit_logs(room_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at DESC);

-- WHITEBOARD PERMISSIONS TABLE
CREATE TABLE IF NOT EXISTS whiteboard_permissions (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
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

CREATE INDEX IF NOT EXISTS idx_whiteboard_permissions_room_id ON whiteboard_permissions(room_id);
CREATE INDEX IF NOT EXISTS idx_whiteboard_permissions_participant_id ON whiteboard_permissions(participant_id);

-- Add missing columns to existing tables (idempotent)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS whiteboard_config JSONB DEFAULT '{"default_access": "all", "host_can_override": true}';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_config JSONB NOT NULL DEFAULT '{"force_recording": false, "duplicate_participant_policy": "allow", "empty_room_timeout_minutes": 30, "recording_retention_days": 90, "auto_start_recording": false, "allow_early_join": true}'::jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS whiteboard_state JSONB;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scheduled_start_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS scheduled_end_at TIMESTAMPTZ;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS allow_early_join_minutes INT NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE recordings ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_status_check;
ALTER TABLE rooms ADD CONSTRAINT rooms_status_check
  CHECK (status IN ('scheduled', 'active', 'ended'));
ALTER TABLE rooms DROP CONSTRAINT IF EXISTS rooms_allow_early_join_minutes_nonnegative;
ALTER TABLE rooms ADD CONSTRAINT rooms_allow_early_join_minutes_nonnegative
  CHECK (allow_early_join_minutes >= 0);

-- Create indexes that depend on columns added above
CREATE INDEX IF NOT EXISTS idx_rooms_whiteboard_state ON rooms USING GIN (whiteboard_state) WHERE whiteboard_state IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rooms_tenant_scheduled_start ON rooms(tenant_id, scheduled_start_at DESC) WHERE status = 'scheduled';

-- ============================================================================
-- MIGRATION 005: Add 'failed' status to recordings
-- ============================================================================
ALTER TABLE recordings DROP CONSTRAINT IF EXISTS recordings_status_check;
ALTER TABLE recordings ADD CONSTRAINT recordings_status_check
  CHECK (status IN ('recording', 'processing', 'ready', 'archived', 'deleted', 'failed'));

-- ============================================================================
-- MIGRATION 006: Transcripts table for real-time transcriptions
-- ============================================================================
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

-- ============================================================================
-- MIGRATION 007: Post-meeting transcripts (from recordings via Groq/Whisper)
-- ============================================================================
CREATE TABLE IF NOT EXISTS post_meeting_transcripts (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    recording_id UUID NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    transcript_text TEXT,
    transcript_json JSONB,
    language VARCHAR(10),
    duration_seconds INT,
    word_count INT,
    provider VARCHAR(50),
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
-- MIGRATION 007: Webhook deliveries table for retry support
-- ============================================================================
CREATE TABLE IF NOT EXISTS webhook_deliveries (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    recording_id UUID REFERENCES recordings(id) ON DELETE SET NULL,
    transcript_id UUID REFERENCES post_meeting_transcripts(id) ON DELETE SET NULL,
    event_type VARCHAR(100) NOT NULL,
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

	-- ============================================================================
	-- MIGRATION 013: Screen annotations
	-- ============================================================================
	ALTER TABLE rooms
	ADD COLUMN IF NOT EXISTS screen_annotation_state JSONB;

	COMMENT ON COLUMN rooms.screen_annotation_state IS 'Screen annotation state JSON (share session, items, access mode)';

	CREATE INDEX IF NOT EXISTS idx_rooms_screen_annotation_state
	ON rooms USING GIN (screen_annotation_state)
	WHERE screen_annotation_state IS NOT NULL;

	-- ============================================================================
	-- MIGRATION 014: Whisper job history
	-- ============================================================================
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

	-- ============================================================================
	-- MIGRATION 008: Internal tenants + end-user auth primitives
	-- ============================================================================
	CREATE TABLE IF NOT EXISTS users (
	    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
	    email TEXT NOT NULL,
	    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_lower_unique ON users (lower(email));

	DROP TRIGGER IF EXISTS update_users_updated_at ON users;
	CREATE TRIGGER update_users_updated_at
	    BEFORE UPDATE ON users
	    FOR EACH ROW
	    EXECUTE FUNCTION update_updated_at_column();

	CREATE TABLE IF NOT EXISTS user_sessions (
	    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
	    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
	    refresh_token_hash TEXT NOT NULL,
	    expires_at TIMESTAMPTZ NOT NULL,
	    revoked_at TIMESTAMPTZ,
	    last_used_at TIMESTAMPTZ,
	    ip_address INET,
	    user_agent TEXT,
	    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id ON user_sessions(user_id);
	CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
	CREATE INDEX IF NOT EXISTS idx_user_sessions_refresh_token_hash ON user_sessions(refresh_token_hash);

	ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_kind TEXT NOT NULL DEFAULT 'external';
	ALTER TABLE tenants ADD COLUMN IF NOT EXISTS owner_user_id UUID;
	ALTER TABLE tenants ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

	DO $$
	BEGIN
	    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_tenant_kind_check') THEN
	        ALTER TABLE tenants
	            ADD CONSTRAINT tenants_tenant_kind_check
	            CHECK (tenant_kind IN ('external', 'internal'));
	    END IF;
	END$$;

	DO $$
	BEGIN
	    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tenants_owner_user_id_fkey') THEN
	        ALTER TABLE tenants
	            ADD CONSTRAINT tenants_owner_user_id_fkey
	            FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE SET NULL;
	    END IF;
	END$$;

	CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_internal_owner_user_id_unique
	    ON tenants(owner_user_id)
	    WHERE tenant_kind = 'internal' AND owner_user_id IS NOT NULL;

	CREATE TABLE IF NOT EXISTS tenant_claims (
	    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
	    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
	    secret_hash TEXT NOT NULL,
	    expires_at TIMESTAMPTZ NOT NULL,
	    used_at TIMESTAMPTZ,
	    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE INDEX IF NOT EXISTS idx_tenant_claims_tenant_id ON tenant_claims(tenant_id);
	CREATE INDEX IF NOT EXISTS idx_tenant_claims_expires_at ON tenant_claims(expires_at);
	CREATE INDEX IF NOT EXISTS idx_tenant_claims_secret_hash ON tenant_claims(secret_hash);

	-- ============================================================================
	-- MIGRATION 009: Keep internal meeting history while deleting recording files
	-- ============================================================================
	ALTER TABLE recordings
	ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

	CREATE INDEX IF NOT EXISTS idx_recordings_deleted_at ON recordings(deleted_at);

	-- ============================================================================
	-- MIGRATION 010: Join hot-path indexes
	-- ============================================================================
	CREATE INDEX IF NOT EXISTS idx_rooms_tenant_name_created_at
	    ON rooms (tenant_id, name, created_at DESC);

	CREATE INDEX IF NOT EXISTS idx_participants_room_external_user_created_at
	    ON participants (room_id, external_user_id, created_at DESC);

	-- ============================================================================
	-- MIGRATION 011: Room scheduling
	-- ============================================================================
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

	-- ============================================================================
	-- MIGRATION 012: Durable chat
	-- ============================================================================
	CREATE TABLE IF NOT EXISTS chat_messages (
	    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
	    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
	    sender_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
	    sender_identity_key TEXT NOT NULL,
	    sender_display_name VARCHAR(255) NOT NULL DEFAULT '',
	    content TEXT NOT NULL DEFAULT '',
	    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE INDEX IF NOT EXISTS idx_chat_messages_room_created_at
	    ON chat_messages (room_id, created_at ASC, id ASC);

	CREATE TABLE IF NOT EXISTS chat_attachments (
	    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
	    room_id UUID NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
	    message_id UUID REFERENCES chat_messages(id) ON DELETE CASCADE,
	    uploaded_by_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
	    file_name VARCHAR(255) NOT NULL,
	    mime_type VARCHAR(255) NOT NULL,
	    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0 AND size_bytes <= 26214400),
	    kind VARCHAR(20) NOT NULL CHECK (kind IN ('image', 'document', 'file')),
	    storage_key VARCHAR(500) NOT NULL UNIQUE,
	    status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attached')),
	    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
	);

	CREATE INDEX IF NOT EXISTS idx_chat_attachments_room_created_at
	    ON chat_attachments (room_id, created_at ASC, id ASC);

	CREATE INDEX IF NOT EXISTS idx_chat_attachments_message_id
	    ON chat_attachments (message_id);

	CREATE TABLE IF NOT EXISTS chat_message_reads (
	    message_id UUID NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
	    reader_participant_id UUID NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
	    reader_identity_key TEXT NOT NULL,
	    reader_display_name VARCHAR(255) NOT NULL DEFAULT '',
	    read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
	    PRIMARY KEY (message_id, reader_identity_key)
	);

	CREATE INDEX IF NOT EXISTS idx_chat_message_reads_participant_read_at
	    ON chat_message_reads (reader_participant_id, read_at DESC);
	`
	_, err := p.Exec(ctx, schema)
	if err != nil {
		return fmt.Errorf("failed to run migrations: %w", err)
	}
	return nil
}
