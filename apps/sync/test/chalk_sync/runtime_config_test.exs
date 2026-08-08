defmodule ChalkSync.RuntimeConfigTest do
  use ExUnit.Case, async: false

  @sync_root Path.expand("../..", __DIR__)
  @public_key Base.url_encode64(:binary.copy(<<0>>, 32), padding: false)
  @env_names ~w(
    MIX_ENV
    PORT
    CHALK_SYNC_PORT
    CHALK_DATABASE_URL
    CHALK_SYNC_DATABASE_POOL_SIZE
    CHALK_SYNC_TOKEN_ISSUER
    CHALK_SYNC_TOKEN_AUDIENCE
    CHALK_SYNC_TOKEN_PUBLIC_KEYS
    CHALK_SYNC_MAX_WAL_LAG_BYTES
    CHALK_SYNC_PROVIDER_BRIDGE_URL
    CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE
    CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE
    CHALK_SYNC_PROVIDER_BRIDGE_CAFILE
    CHALK_EPISODE_DIAGNOSTICS
    CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN
    CHALK_API_ENV
    CHALK_API_URL
    CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS
    CHALK_SYNC_INSTANCE_ID
    CHALK_SYNC_GENERATION
    CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN
    CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER
    CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID
    CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY
    CHALK_SYNC_RELEASE_ID
    CHALK_SYNC_SOURCE_COMMIT
    CHALK_SYNC_LOCAL_PROOF
    CHALK_SYNC_LOCAL_PARITY
    CHALK_SYNC_BIND_IP
  )

  test "local parity selects the production-shaped localhost configuration" do
    config = read_config([{"CHALK_SYNC_LOCAL_PARITY", "true"}, {"PORT", "4111"}])

    assert config[:port] == 4111
    assert config[:listen_ip] == {127, 0, 0, 1}
    assert config[:stateholder] == ChalkSync.Stateholder.Postgres
    assert config[:token_verifier] == ChalkSync.Auth.JWTTokenVerifier
    assert config[:require_production_auth]
    assert config[:enforce_production_boot_checks]
    refute config[:enable_v1]
    refute config[:require_synchronous_standby]
    assert config[:local_parity]
  end

  test "CHALK_SYNC_PORT is the explicit port override in production" do
    config =
      read_config([
        {"CHALK_SYNC_LOCAL_PARITY", "true"},
        {"PORT", "4111"},
        {"CHALK_SYNC_PORT", "4112"}
      ])

    assert config[:port] == 4112
  end

  test "local parity rejects remote databases, bridges, and loopback overrides" do
    cases = [
      {
        [
          {"CHALK_DATABASE_URL",
           "postgres://postgres:postgres@db.example.test:5432/chalk?sslmode=disable"}
        ],
        "CHALK_SYNC_LOCAL_PARITY requires a localhost database"
      },
      {
        [{"CHALK_SYNC_PROVIDER_BRIDGE_URL", "https://api.example.test:8443"}],
        "CHALK_SYNC_LOCAL_PARITY requires a localhost provider bridge"
      },
      {
        [{"CHALK_SYNC_BIND_IP", "0.0.0.0"}],
        "CHALK_SYNC_LOCAL_PARITY requires a localhost bind address"
      },
      {
        [{"CHALK_SYNC_LOCAL_PROOF", "true"}],
        "CHALK_SYNC_LOCAL_PROOF and CHALK_SYNC_LOCAL_PARITY cannot both be true"
      },
      {
        [{"CHALK_SYNC_TOKEN_ISSUER", nil}],
        "CHALK_SYNC_TOKEN_ISSUER must be set in prod"
      }
    ]

    Enum.each(cases, fn {overrides, expected_error} ->
      assert_raise RuntimeError, expected_error, fn ->
        read_config([{"CHALK_SYNC_LOCAL_PARITY", "true"} | overrides])
      end
    end)
  end

  test "legacy local proof remains development-authenticated" do
    config =
      read_config([
        {"CHALK_SYNC_LOCAL_PROOF", "true"},
        {"CHALK_SYNC_TOKEN_ISSUER", nil},
        {"CHALK_SYNC_TOKEN_AUDIENCE", nil},
        {"CHALK_SYNC_TOKEN_PUBLIC_KEYS", nil}
      ])

    assert config[:token_verifier] == ChalkSync.Auth.DevTokenVerifier
    refute config[:require_production_auth]
    refute config[:require_synchronous_standby]
    refute config[:local_parity]
  end

  test "hosted diagnostics require and preserve deployment-owned destination hosts" do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)

    config =
      read_config([
        {"CHALK_EPISODE_DIAGNOSTICS", "hosted"},
        {"CHALK_API_ENV", "staging"},
        {"CHALK_API_URL", "https://api.example.test"},
        {"CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS", "api.example.test,api.staging.example.test"},
        {"CHALK_SYNC_INSTANCE_ID", "sync-runtime-test"},
        {"CHALK_SYNC_GENERATION", "4"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER", "https://identity.example.test"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID", "sync-diagnostics-1"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY",
         encoded_private_key(private_seed, public_key)}
      ])

    assert config[:episode_diagnostics][:mode] == :hosted
    assert config[:episode_diagnostics][:base_url] == "https://api.example.test"

    assert config[:episode_diagnostics][:allowed_hosts] == [
             "api.example.test",
             "api.staging.example.test"
           ]
  end

  test "hosted diagnostics are accepted in production only with the explicit opt-in" do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)

    config =
      read_config([
        {"CHALK_EPISODE_DIAGNOSTICS", "hosted"},
        {"CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN", "true"},
        {"CHALK_API_ENV", "production"},
        {"CHALK_API_URL", "https://api.example.test"},
        {"CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS", "api.example.test"},
        {"CHALK_SYNC_INSTANCE_ID", "sync-runtime-production-test"},
        {"CHALK_SYNC_GENERATION", "4"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER", "https://identity.example.test"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID", "sync-diagnostics-1"},
        {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY",
         encoded_private_key(private_seed, public_key)}
      ])

    assert config[:episode_diagnostics][:mode] == :hosted
    assert config[:episode_diagnostics][:credential].environment == "production"
  end

  test "production hosted diagnostics still requires complete hosted configuration" do
    error =
      assert_raise RuntimeError, fn ->
        read_config([
          {"CHALK_EPISODE_DIAGNOSTICS", "hosted"},
          {"CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN", "true"},
          {"CHALK_API_ENV", "production"},
          {"CHALK_API_URL", "https://api.example.test"},
          {"CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS", "api.example.test"},
          {"CHALK_SYNC_INSTANCE_ID", "sync-runtime-production-test"},
          {"CHALK_SYNC_GENERATION", "4"}
        ])
      end

    assert error.message ==
             "CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER must be set for hosted diagnostics"
  end

  test "production hosted diagnostics names the opt-in when it is absent" do
    error =
      assert_raise RuntimeError, fn ->
        read_config([{"CHALK_EPISODE_DIAGNOSTICS", "hosted"}, {"CHALK_API_ENV", "production"}])
      end

    assert error.message ==
             "CHALK_EPISODE_DIAGNOSTICS=hosted requires CHALK_API_ENV=development or staging, or CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN=true in production"
  end

  test "production hosted diagnostics requires the exact opt-in and never enables localhost mode" do
    {public_key, private_seed} = :crypto.generate_key(:eddsa, :ed25519)
    private_key = encoded_private_key(private_seed, public_key)

    hosted_base = [
      {"CHALK_EPISODE_DIAGNOSTICS", "hosted"},
      {"CHALK_API_ENV", "production"},
      {"CHALK_API_URL", "https://api.example.test"},
      {"CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS", "api.example.test"},
      {"CHALK_SYNC_INSTANCE_ID", "sync-runtime-production-test"},
      {"CHALK_SYNC_GENERATION", "4"},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER", "https://identity.example.test"},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID", "sync-diagnostics-1"},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY", private_key}
    ]

    for opt_in <- ["", "false", "TRUE", "1", " true"] do
      assert_raise RuntimeError,
                   "CHALK_EPISODE_DIAGNOSTICS=hosted requires CHALK_API_ENV=development or staging, or CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN=true in production",
                   fn ->
                     read_config(
                       hosted_base ++ [{"CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN", opt_in}]
                     )
                   end
    end

    assert_raise RuntimeError,
                 "CHALK_EPISODE_DIAGNOSTICS=localhost requires CHALK_API_ENV=local",
                 fn ->
                   read_config([
                     {"CHALK_EPISODE_DIAGNOSTICS", "localhost"},
                     {"CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN", "true"},
                     {"CHALK_API_ENV", "production"},
                     {"CHALK_API_URL", "https://api.example.test"},
                     {"CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN", "producer-secret"}
                   ])
                 end
  end

  defp base_env do
    [
      {"MIX_ENV", "prod"},
      {"PORT", "4100"},
      {"CHALK_DATABASE_URL", "postgres://postgres:postgres@127.0.0.1:5432/chalk?sslmode=disable"},
      {"CHALK_SYNC_DATABASE_POOL_SIZE", "2"},
      {"CHALK_SYNC_TOKEN_ISSUER", "https://api.local"},
      {"CHALK_SYNC_TOKEN_AUDIENCE", "chalk-sync"},
      {"CHALK_SYNC_TOKEN_PUBLIC_KEYS", ~s({"local": "#{@public_key}"})},
      {"CHALK_SYNC_MAX_WAL_LAG_BYTES", "0"},
      {"CHALK_SYNC_PROVIDER_BRIDGE_URL", "https://127.0.0.1:8443"},
      {"CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE", "/tmp/chalk-sync-local-cert.pem"},
      {"CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE", "/tmp/chalk-sync-local-key.pem"},
      {"CHALK_SYNC_PROVIDER_BRIDGE_CAFILE", "/tmp/chalk-sync-local-ca.pem"},
      {"CHALK_SYNC_LOCAL_PROOF", nil},
      {"CHALK_SYNC_LOCAL_PARITY", nil},
      {"CHALK_SYNC_BIND_IP", nil},
      {"CHALK_SYNC_PORT", nil},
      {"CHALK_EPISODE_DIAGNOSTICS", nil},
      {"CHALK_EPISODE_DIAGNOSTICS_PRODUCTION_OPT_IN", nil},
      {"CHALK_API_ENV", nil},
      {"CHALK_API_URL", nil},
      {"CHALK_SYNC_DIAGNOSTICS_ALLOWED_HOSTS", nil},
      {"CHALK_SYNC_INSTANCE_ID", nil},
      {"CHALK_SYNC_GENERATION", nil},
      {"CHALK_EPISODE_DIAGNOSTICS_PRODUCER_TOKEN", nil},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_ISSUER", nil},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_KEY_ID", nil},
      {"CHALK_EPISODE_DIAGNOSTICS_SERVICE_PRIVATE_KEY", nil},
      {"CHALK_SYNC_RELEASE_ID", nil},
      {"CHALK_SYNC_SOURCE_COMMIT", nil}
    ]
  end

  defp merge_env(env, overrides) do
    Enum.reduce(overrides, env, fn {key, value}, acc ->
      put_env(acc, key, value)
    end)
  end

  defp put_env(env, key, value), do: List.keystore(env, key, 0, {key, value})

  defp encoded_private_key(private_seed, public_key),
    do: Base.url_encode64(private_seed <> public_key, padding: false)

  defp read_config(overrides) do
    environment = merge_env(base_env(), overrides)
    previous = Map.new(@env_names, &{&1, System.get_env(&1)})

    try do
      Enum.each(@env_names, &System.delete_env/1)

      Enum.each(environment, fn
        {_key, nil} -> :ok
        {key, value} -> System.put_env(key, value)
      end)

      runtime_path = Path.join(@sync_root, "config/runtime.exs")
      [chalk_sync: config] = Config.Reader.read!(runtime_path, env: :prod)
      Map.new(config)
    after
      Enum.each(previous, fn
        {_key, nil} -> :ok
        {key, value} -> System.put_env(key, value)
      end)

      Enum.each(@env_names, fn key ->
        if is_nil(Map.get(previous, key)), do: System.delete_env(key)
      end)
    end
  end
end
