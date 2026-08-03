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
      {"CHALK_SYNC_PORT", nil}
    ]
  end

  defp merge_env(env, overrides) do
    Enum.reduce(overrides, env, fn {key, value}, acc ->
      put_env(acc, key, value)
    end)
  end

  defp put_env(env, key, value), do: List.keystore(env, key, 0, {key, value})

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
