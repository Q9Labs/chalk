import Config

if config_env() == :prod do
  config :chalk_sync, port: String.to_integer(System.get_env("PORT", "4100"))

  # The dev token verifier is a non-verifying stand-in and must never run in
  # prod. Fails startup until the per-tenant signature verifier lands.
  verifier =
    System.get_env("CHALK_SYNC_TOKEN_VERIFIER") ||
      raise "CHALK_SYNC_TOKEN_VERIFIER must be set in prod"

  config :chalk_sync, token_verifier: Module.concat([verifier])
end
