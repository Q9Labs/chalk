-- Tenant configuration column for advanced settings
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS tenant_config JSONB NOT NULL DEFAULT '{
    "force_recording": false,
    "duplicate_participant_policy": "allow",
    "empty_room_timeout_minutes": 30,
    "recording_retention_days": 90,
    "auto_start_recording": false,
    "allow_early_join": true
}'::jsonb;
