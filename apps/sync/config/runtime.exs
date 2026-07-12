import Config

if config_env() == :prod do
  config :chalk_sync, port: String.to_integer(System.get_env("PORT", "4100"))

  database_url =
    System.get_env("CHALK_DATABASE_URL") || raise "CHALK_DATABASE_URL must be set in prod"

  local_proof? = System.get_env("CHALK_SYNC_LOCAL_PROOF") == "true"

  if local_proof? and URI.parse(database_url).host not in ["127.0.0.1", "localhost"] do
    raise "CHALK_SYNC_LOCAL_PROOF requires a localhost database"
  end

  listen_ip =
    if local_proof? do
      {127, 0, 0, 1}
    else
      System.get_env("CHALK_SYNC_BIND_IP", "0.0.0.0")
      |> String.to_charlist()
      |> :inet.parse_address()
      |> case do
        {:ok, address} -> address
        {:error, _reason} -> raise "CHALK_SYNC_BIND_IP must be a numeric IP address"
      end
    end

  database_pool_size =
    System.get_env("CHALK_SYNC_DATABASE_POOL_SIZE", "8")
    |> Integer.parse()
    |> case do
      {value, ""} when value > 0 and value <= 64 -> value
      _ -> raise "CHALK_SYNC_DATABASE_POOL_SIZE must be an integer between 1 and 64"
    end

  config :chalk_sync,
    stateholder: ChalkSync.Stateholder.Postgres,
    database_url: database_url,
    database_pool_size: database_pool_size,
    listen_ip: listen_ip

  verifier =
    if local_proof? do
      ChalkSync.Auth.DevTokenVerifier
    else
      System.get_env("CHALK_SYNC_TOKEN_VERIFIER") ||
        raise "CHALK_SYNC_TOKEN_VERIFIER must be set in prod"
    end

  if verifier == "ChalkSync.Auth.DevTokenVerifier" do
    raise "CHALK_SYNC_TOKEN_VERIFIER cannot use the development verifier in prod"
  end

  verifier = if is_binary(verifier), do: Module.concat([verifier]), else: verifier

  max_wal_lag_bytes =
    System.get_env("CHALK_SYNC_MAX_WAL_LAG_BYTES")
    |> case do
      nil ->
        raise "CHALK_SYNC_MAX_WAL_LAG_BYTES must be set in prod"

      encoded ->
        case Integer.parse(encoded) do
          {value, ""} when value >= 0 -> value
          _ -> raise "CHALK_SYNC_MAX_WAL_LAG_BYTES must be a nonnegative integer"
        end
    end

  config :chalk_sync,
    enable_v1: false,
    enforce_production_boot_checks: true,
    max_synchronous_wal_lag_bytes: max_wal_lag_bytes,
    require_production_auth: not local_proof?,
    require_synchronous_standby: not local_proof?,
    token_verifier: verifier
end
