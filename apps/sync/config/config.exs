import Config

config :chalk_sync,
  dev_tools: false,
  port: 4100,
  stateholder: ChalkSync.Stateholder.Memory,
  token_verifier: ChalkSync.Auth.DevTokenVerifier

import_config "#{config_env()}.exs"
