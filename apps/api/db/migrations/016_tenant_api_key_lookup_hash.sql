-- MIGRATION 016: O(1) tenant API key lookup

ALTER TABLE tenants
    ADD COLUMN IF NOT EXISTS api_key_lookup_hash VARCHAR(64);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_api_key_lookup_hash
    ON tenants(api_key_lookup_hash)
    WHERE api_key_lookup_hash IS NOT NULL;
