import Config

# Bandit binds an ephemeral port in tests; see test/support/server_case.ex.
config :chalk_sync, port: 0
config :chalk_sync, dev_tools: true

config :logger, level: :warning
