import Config

if port = System.get_env("CHALK_SYNC_PORT") do
  config :chalk_sync, port: String.to_integer(port)
end

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
      ChalkSync.Auth.JWTTokenVerifier
    end

  token_config =
    if local_proof? do
      []
    else
      issuer =
        System.get_env("CHALK_SYNC_TOKEN_ISSUER") ||
          raise "CHALK_SYNC_TOKEN_ISSUER must be set in prod"

      audience =
        System.get_env("CHALK_SYNC_TOKEN_AUDIENCE") ||
          raise "CHALK_SYNC_TOKEN_AUDIENCE must be set in prod"

      encoded_keys =
        System.get_env("CHALK_SYNC_TOKEN_PUBLIC_KEYS") ||
          raise "CHALK_SYNC_TOKEN_PUBLIC_KEYS must be set in prod"

      public_keys =
        case JSON.decode(encoded_keys) do
          {:ok, keys} when is_map(keys) and map_size(keys) > 0 ->
            Map.new(keys, fn
              {key_id, encoded_key} when is_binary(key_id) and is_binary(encoded_key) ->
                case Base.url_decode64(encoded_key, padding: false) do
                  {:ok, key} when byte_size(key) == 32 -> {key_id, key}
                  _ -> raise "CHALK_SYNC_TOKEN_PUBLIC_KEYS contains an invalid Ed25519 key"
                end

              _ ->
                raise "CHALK_SYNC_TOKEN_PUBLIC_KEYS must map key ids to base64url keys"
            end)

          _ ->
            raise "CHALK_SYNC_TOKEN_PUBLIC_KEYS must be a non-empty JSON object"
        end

      [token_issuer: issuer, token_audience: audience, token_public_keys: public_keys]
    end

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

  provider_bridge =
    [
      base_url: "CHALK_SYNC_PROVIDER_BRIDGE_URL",
      certfile: "CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE",
      keyfile: "CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE",
      cacertfile: "CHALK_SYNC_PROVIDER_BRIDGE_CAFILE"
    ]
    |> Enum.map(fn {key, environment_name} ->
      value =
        System.get_env(environment_name) ||
          raise "#{environment_name} must be set in prod"

      if String.trim(value) == "", do: raise("#{environment_name} must not be empty")
      {key, value}
    end)

  case URI.parse(Keyword.fetch!(provider_bridge, :base_url)) do
    %URI{
      scheme: "https",
      host: host,
      userinfo: nil,
      query: nil,
      fragment: nil,
      path: path
    }
    when is_binary(host) and host != "" and path in [nil, "", "/"] ->
      :ok

    _other ->
      raise "CHALK_SYNC_PROVIDER_BRIDGE_URL must be an HTTPS origin without credentials, path, query, or fragment"
  end

  config :chalk_sync,
    enable_v1: false,
    enforce_production_boot_checks: true,
    max_synchronous_wal_lag_bytes: max_wal_lag_bytes,
    provider_bridge: provider_bridge,
    require_production_auth: not local_proof?,
    require_synchronous_standby: not local_proof?,
    token_verifier: verifier

  config :chalk_sync, token_config
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
