import Config

config :chalk_sync,
  dev_tools: false,
  database_pool_size: 8,
  enable_v1: true,
  enforce_production_boot_checks: false,
  listen_ip: {127, 0, 0, 1},
  max_synchronous_wal_lag_bytes: 0,
  port: 4100,
  required_sync_migration: 20_260_712_180_000,
  retention_cleanup_interval_ms: 1_000,
  require_production_auth: false,
  require_synchronous_standby: false,
  stateholder: ChalkSync.Stateholder.Memory,
  token_verifier: ChalkSync.Auth.DevTokenVerifier

import_config "#{config_env()}.exs"
