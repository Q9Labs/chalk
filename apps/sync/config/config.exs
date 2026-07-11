import Config

config :chalk_sync,
  dev_tools: false,
  port: 4100,
  stateholder: ChalkSync.Stateholder.Memory,
  token_verifier: ChalkSync.Auth.DevTokenVerifier,
  observability: [enabled: false, runtime_health_interval_ms: 30_000]

config :opentelemetry, traces_exporter: :none
config :opentelemetry_exporter, otlp_protocol: :http_protobuf

import_config "#{config_env()}.exs"
