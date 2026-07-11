import Config

if port = System.get_env("CHALK_SYNC_PORT") do
  config :chalk_sync, port: String.to_integer(port)
end

if config_env() == :prod do
  config :chalk_sync, port: String.to_integer(System.get_env("PORT", "4100"))

  # The dev token verifier is a non-verifying stand-in and must never run in
  # prod. Fails startup until the per-tenant signature verifier lands.
  verifier =
    System.get_env("CHALK_SYNC_TOKEN_VERIFIER") ||
      raise "CHALK_SYNC_TOKEN_VERIFIER must be set in prod"

  config :chalk_sync, token_verifier: Module.concat([verifier])
end

if endpoint = System.get_env("CHALK_SYNC_OTLP_ENDPOINT") do
  config :chalk_sync, observability: [enabled: true, runtime_health_interval_ms: 30_000]

  config :opentelemetry,
    span_processor: :batch,
    traces_exporter: :otlp,
    resource: %{service: %{name: "chalk-sync"}}

  config :opentelemetry_exporter,
    otlp_protocol: :http_protobuf,
    otlp_endpoint: endpoint
end
