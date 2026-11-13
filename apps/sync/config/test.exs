import Config

# Bandit binds an ephemeral port in tests; see test/support/server_case.ex.
config :chalk_sync, database_workers: false, port: 0

config :logger, level: :warning
