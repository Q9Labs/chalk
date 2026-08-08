import Config

if port = System.get_env("CHALK_SYNC_PORT") do
  config :chalk_sync, port: String.to_integer(port)
end

diagnostics_mode = System.get_env("CHALK_EPISODE_DIAGNOSTICS", "off")
api_environment = System.get_env("CHALK_API_ENV", "production")
production_opt_in? = System.get_env("CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN") == "true"

diagnostics_mode =
  case diagnostics_mode do
    "off" ->
      :off

    "localhost" ->
      if api_environment not in ["local", "localhost"] do
        raise "CHALK_EPISODE_DIAGNOSTICS=localhost requires CHALK_API_ENV=local"
      end

      :localhost

    "hosted" ->
      if api_environment not in ["development", "staging"] and
           not (api_environment == "production" and production_opt_in?) do
        raise "CHALK_EPISODE_DIAGNOSTICS=hosted requires CHALK_API_ENV=development or staging, or CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN=true in production"
      end

      :hosted

    _ ->
      raise "CHALK_EPISODE_DIAGNOSTICS must be one of off, localhost, hosted"
  end

if api_environment == "production" and diagnostics_mode != :off do
  unless diagnostics_mode == :hosted and production_opt_in? do
    raise "Episode diagnostics must be off in production unless CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN=true"
  end
end

if diagnostics_mode == :off do
  config :chalk_sync, episode_diagnostics: %{mode: :off}
else
  api_url =
    System.get_env("CHALK_API_URL") ||
      raise "CHALK_API_URL must be set when Episode diagnostics are enabled"

  base_url = String.trim_trailing(api_url, "/")
  parsed_api_url = URI.parse(base_url)

  allowed_hosts =
    case diagnostics_mode do
      :localhost ->
        [parsed_api_url.host]

      :hosted ->
        allowed_hosts =
          System.get_env("CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS") ||
            raise "CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS must be set for hosted diagnostics"

        String.split(allowed_hosts, ",", trim: true)
    end

  case {diagnostics_mode, parsed_api_url} do
    {:localhost,
     %URI{scheme: "http", host: host, userinfo: nil, query: nil, fragment: nil, path: path}}
    when host in ["localhost", "127.0.0.1", "::1"] and path in [nil, "", "/"] ->
      :ok

    {:hosted,
     %URI{scheme: "https", host: host, userinfo: nil, query: nil, fragment: nil, path: path}}
    when is_binary(host) and host != "" and path in [nil, "", "/"] ->
      :ok

    {:localhost, _uri} ->
      raise "CHALK_API_URL must be a localhost HTTP origin for localhost diagnostics"

    {:hosted, _uri} ->
      raise "CHALK_API_URL must be an HTTPS origin for hosted diagnostics"
  end

  instance_id =
    case {diagnostics_mode, System.get_env("CHALK_SYNC_INSTANCE_ID")} do
      {:hosted, nil} ->
        raise "CHALK_SYNC_INSTANCE_ID must be set for hosted Episode diagnostics"

      {_mode, nil} ->
        Base.url_encode64(:crypto.strong_rand_bytes(18), padding: false)

      {_mode, value} ->
        value
    end

  {generation, authentication} =
    case diagnostics_mode do
      :localhost ->
        if Enum.any?(
             [
               "CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER",
               "CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID",
               "CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY"
             ],
             &System.get_env/1
           ) do
          raise "Episode diagnostics service signing configuration is hosted-only"
        end

        producer_token =
          System.get_env("CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN") ||
            raise "CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN must be set for localhost diagnostics"

        {1, %{token: producer_token}}

      :hosted ->
        if System.get_env("CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN") do
          raise "CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN is localhost-only"
        end

        issuer =
          System.get_env("CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER") ||
            raise "CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER must be set for hosted diagnostics"

        key_id =
          System.get_env("CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID") ||
            raise "CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID must be set for hosted diagnostics"

        encoded_private_key =
          System.get_env("CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY") ||
            raise "CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY must be set for hosted diagnostics"

        private_key =
          case Base.url_decode64(encoded_private_key, padding: false) do
            {:ok, decoded} when byte_size(decoded) == 64 ->
              decoded

            _invalid ->
              raise "CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY must be an unpadded base64url Ed25519 private key"
          end

        generation =
          case System.get_env("CHALK_SYNC_GENERATION") do
            nil ->
              raise "CHALK_SYNC_GENERATION must be set for hosted Episode diagnostics"

            encoded ->
              case Integer.parse(encoded) do
                {value, ""} when value in 1..2_147_483_648 ->
                  value

                _invalid ->
                  raise "CHALK_SYNC_GENERATION must be an integer between 1 and 2147483648"
              end
          end

        credential =
          case ChalkSync.Diagnostics.ServiceCredential.new(
                 issuer: issuer,
                 key_id: key_id,
                 private_key: private_key,
                 environment: api_environment,
                 instance_id: instance_id,
                 generation: generation
               ) do
            {:ok, credential} -> credential
            {:error, :invalid_config} -> raise "hosted Episode diagnostics credential is invalid"
          end

        {generation, %{credential: credential}}
    end

  diagnostics_config =
    %{
      mode: diagnostics_mode,
      base_url: base_url,
      allowed_hosts: allowed_hosts,
      instance_id: instance_id,
      generation: generation,
      connect_timeout_ms: 500,
      request_timeout_ms: 1_500,
      max_request_bytes: 512 * 1024
    }
    |> Map.merge(authentication)

  release_id = System.get_env("CHALK_SYNC_RELEASE_ID")
  source_commit = System.get_env("CHALK_SYNC_SOURCE_COMMIT")
  safe_release = ~r/\A[A-Za-z0-9][A-Za-z0-9._:@+\/=\-]{0,127}\z/

  diagnostics_config =
    case {release_id, source_commit} do
      {nil, nil} ->
        diagnostics_config

      {id, commit}
      when is_binary(id) and (is_nil(commit) or is_binary(commit)) ->
        if not Regex.match?(safe_release, id) or
             (is_binary(commit) and not Regex.match?(safe_release, commit)) do
          raise "CHALK_SYNC_RELEASE_ID and CHALK_SYNC_SOURCE_COMMIT must be safe identifiers"
        end

        release = %{id: id}
        release = if commit, do: Map.put(release, :source_commit, commit), else: release
        Map.put(diagnostics_config, :release, release)

      _invalid ->
        raise "CHALK_SYNC_RELEASE_ID is required when CHALK_SYNC_SOURCE_COMMIT is set"
    end

  if ChalkSync.Diagnostics.Transport.validate_config(diagnostics_config) != :ok do
    raise "Episode diagnostics configuration is invalid"
  end

  config :chalk_sync, episode_diagnostics: diagnostics_config
end

if config_env() == :prod do
  config :chalk_sync,
    port: String.to_integer(System.get_env("CHALK_SYNC_PORT") || System.get_env("PORT", "4100"))

  database_url =
    System.get_env("CHALK_DATABASE_URL") || raise "CHALK_DATABASE_URL must be set in prod"

  local_proof? = System.get_env("CHALK_SYNC_LOCAL_PROOF") == "true"
  local_parity? = System.get_env("CHALK_SYNC_LOCAL_PARITY") == "true"

  if local_proof? and local_parity? do
    raise "CHALK_SYNC_LOCAL_PROOF and CHALK_SYNC_LOCAL_PARITY cannot both be true"
  end

  if local_proof? and URI.parse(database_url).host not in ["127.0.0.1", "localhost"] do
    raise "CHALK_SYNC_LOCAL_PROOF requires a localhost database"
  end

  if local_parity? and URI.parse(database_url).host not in ["127.0.0.1", "localhost", "::1"] do
    raise "CHALK_SYNC_LOCAL_PARITY requires a localhost database"
  end

  if local_parity? and System.get_env("CHALK_SYNC_BIND_IP") not in [nil, "127.0.0.1"] do
    raise "CHALK_SYNC_LOCAL_PARITY requires a localhost bind address"
  end

  listen_ip =
    if local_proof? or local_parity? do
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

  provider_bridge_uri = URI.parse(Keyword.fetch!(provider_bridge, :base_url))

  case provider_bridge_uri do
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

  if local_parity? and provider_bridge_uri.host not in ["127.0.0.1", "localhost", "::1"] do
    raise "CHALK_SYNC_LOCAL_PARITY requires a localhost provider bridge"
  end

  config :chalk_sync,
    enforce_production_boot_checks: true,
    max_synchronous_wal_lag_bytes: max_wal_lag_bytes,
    local_parity: local_parity?,
    provider_bridge: provider_bridge,
    require_production_auth: not local_proof?,
    require_synchronous_standby: not (local_proof? or local_parity?),
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
