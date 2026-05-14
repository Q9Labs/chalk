-- Ops incident platform

CREATE TABLE IF NOT EXISTS ops_incidents (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    incident_code VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    severity VARCHAR(16) NOT NULL CHECK (severity IN ('info', 'minor', 'major', 'critical')),
    status VARCHAR(32) NOT NULL CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved')),
    visibility VARCHAR(16) NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'public')),
    source_kind VARCHAR(16) NOT NULL CHECK (source_kind IN ('manual', 'monitor', 'heartbeat', 'system')),
    source_key VARCHAR(128),
    component_ids TEXT[] NOT NULL DEFAULT '{}',
    dedupe_key VARCHAR(255),
    idempotency_key VARCHAR(255),
    public_message TEXT,
    public_title VARCHAR(255),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    published_at TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    created_by VARCHAR(128) NOT NULL DEFAULT 'system',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_ops_incidents_updated_at ON ops_incidents;
CREATE TRIGGER update_ops_incidents_updated_at
    BEFORE UPDATE ON ops_incidents
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_ops_incidents_status_created_at
    ON ops_incidents (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_visibility_created_at
    ON ops_incidents (visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_source_key_status
    ON ops_incidents (source_key, status)
    WHERE source_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ops_incidents_component_ids
    ON ops_incidents USING GIN (component_ids);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_incidents_active_source_unique
    ON ops_incidents (source_kind, source_key)
    WHERE status <> 'resolved' AND source_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops_incident_events (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    incident_id UUID NOT NULL REFERENCES ops_incidents(id) ON DELETE CASCADE,
    event_type VARCHAR(64) NOT NULL,
    visibility VARCHAR(16) NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal', 'public')),
    actor_kind VARCHAR(16) NOT NULL DEFAULT 'system' CHECK (actor_kind IN ('user', 'agent', 'system')),
    actor_id VARCHAR(128) NOT NULL DEFAULT 'system',
    message TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key VARCHAR(255),
    event_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_incident_events_incident_event_at
    ON ops_incident_events (incident_id, event_at ASC, created_at ASC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_incident_events_incident_idempotency
    ON ops_incident_events (incident_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS ops_monitor_results (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    monitor_key VARCHAR(128) NOT NULL,
    monitor_kind VARCHAR(32) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('healthy', 'degraded', 'failed')),
    http_status INT,
    latency_ms INT,
    checked_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    run_id VARCHAR(128),
    result_key VARCHAR(255) NOT NULL UNIQUE,
    error_code VARCHAR(64),
    error_message TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    reported_source VARCHAR(64),
    reported_emitter_id VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS idx_ops_monitor_results_monitor_checked
    ON ops_monitor_results (monitor_key, checked_at DESC, ingested_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_monitor_results_status_checked
    ON ops_monitor_results (status, checked_at DESC);

CREATE TABLE IF NOT EXISTS ops_heartbeat_events (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    heartbeat_key VARCHAR(128) NOT NULL,
    status VARCHAR(16) NOT NULL CHECK (status IN ('ok', 'failed')),
    event_at TIMESTAMPTZ NOT NULL,
    ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    event_key VARCHAR(255) NOT NULL UNIQUE,
    error_message TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    reported_source VARCHAR(64),
    reported_emitter_id VARCHAR(128)
);

CREATE INDEX IF NOT EXISTS idx_ops_heartbeat_events_key_event_at
    ON ops_heartbeat_events (heartbeat_key, event_at DESC, ingested_at DESC);

CREATE TABLE IF NOT EXISTS ops_notification_deliveries (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    incident_id UUID REFERENCES ops_incidents(id) ON DELETE CASCADE,
    channel VARCHAR(32) NOT NULL CHECK (channel IN ('whatsapp')),
    recipient VARCHAR(128) NOT NULL,
    dedupe_key VARCHAR(255) NOT NULL,
    template VARCHAR(64) NOT NULL,
    status VARCHAR(16) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'retrying', 'failed')),
    provider VARCHAR(32) NOT NULL DEFAULT 'twilio',
    provider_message_id VARCHAR(255),
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    attempts INT NOT NULL DEFAULT 0,
    last_error TEXT,
    sent_at TIMESTAMPTZ,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_ops_notification_deliveries_updated_at ON ops_notification_deliveries;
CREATE TRIGGER update_ops_notification_deliveries_updated_at
    BEFORE UPDATE ON ops_notification_deliveries
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_notification_deliveries_dedupe
    ON ops_notification_deliveries (channel, recipient, dedupe_key);
CREATE INDEX IF NOT EXISTS idx_ops_notification_deliveries_status_next_retry
    ON ops_notification_deliveries (status, next_retry_at ASC);

CREATE TABLE IF NOT EXISTS ops_maintenance_windows (
    id UUID PRIMARY KEY DEFAULT chalk_uuid_v4(),
    title VARCHAR(255) NOT NULL,
    summary TEXT,
    component_ids TEXT[] NOT NULL DEFAULT '{}',
    visibility VARCHAR(16) NOT NULL DEFAULT 'public' CHECK (visibility IN ('internal', 'public')),
    status VARCHAR(16) NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled', 'completed')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    created_by VARCHAR(128) NOT NULL DEFAULT 'system',
    public_message TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    cancelled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS update_ops_maintenance_windows_updated_at ON ops_maintenance_windows;
CREATE TRIGGER update_ops_maintenance_windows_updated_at
    BEFORE UPDATE ON ops_maintenance_windows
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE INDEX IF NOT EXISTS idx_ops_maintenance_windows_status_starts_at
    ON ops_maintenance_windows (status, starts_at ASC);
