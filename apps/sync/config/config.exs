import Config

config :chalk_sync,
  dev_tools: false,
  database_pool_size: 8,
  enable_v1: true,
  enforce_production_boot_checks: false,
  external_operation_adapter_timeout_ms: 5_000,
  external_operation_poll_interval_ms: 100,
  listen_ip: {127, 0, 0, 1},
  max_synchronous_wal_lag_bytes: 0,
  port: 4100,
  # Sync v3 requires its stateholder tables, constraints, and columns at this
  # floor. Later additive API and recorder migrations remain compatible.
  minimum_compatible_sync_migration: 20_260_713_130_000,
  provider_bridge: nil,
  retention_cleanup_interval_ms: 1_000,
  require_production_auth: false,
  require_synchronous_standby: false,
  stateholder: ChalkSync.Stateholder.Memory,
  token_verifier: ChalkSync.Auth.DevTokenVerifier,
  token_audience: nil,
  token_issuer: nil,
  token_public_keys: %{},
  observability: [enabled: false, runtime_health_interval_ms: 30_000]

config :opentelemetry, traces_exporter: :none
config :opentelemetry_exporter, otlp_protocol: :http_protobuf

import_config "#{config_env()}.exs"
