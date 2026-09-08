defmodule ChalkSync.Operations.ProductionConfigTest do
  use ExUnit.Case, async: false

  setup do
    values = %{
      "CHALK_EPISODE_DIAGNOSTICS" => "off",
      "CHALK_SYNC_LOCAL_PROOF" => "false",
      "CHALK_SYNC_LOCAL_PARITY" => "false",
      "CHALK_DATABASE_URL" => "postgresql://localhost/chalk_test",
      "CHALK_SYNC_TOKEN_ISSUER" => "https://example.test",
      "CHALK_SYNC_TOKEN_AUDIENCE" => "chalk-sync",
      "CHALK_SYNC_TOKEN_PUBLIC_KEYS" =>
        JSON.encode!(%{"test" => Base.url_encode64(<<0::256>>, padding: false)}),
      "CHALK_SYNC_MAX_WAL_LAG_BYTES" => "0",
      "CHALK_SYNC_PROVIDER_BRIDGE_URL" => "https://example.test",
      "CHALK_SYNC_PROVIDER_BRIDGE_CERTFILE" => "/test/client.crt",
      "CHALK_SYNC_PROVIDER_BRIDGE_KEYFILE" => "/test/client.key",
      "CHALK_SYNC_PROVIDER_BRIDGE_CAFILE" => "/test/ca.crt",
      "CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY" => nil
    }

    previous = Map.new(values, fn {key, _value} -> {key, System.get_env(key)} end)
    System.put_env(values)
    on_exit(fn -> System.put_env(previous) end)
    :ok
  end

  test "production defaults to HA and only an explicit false selects single-node" do
    assert read_config()[:require_synchronous_standby]
    System.put_env("CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY", "false")
    config = read_config()
    refute config[:require_synchronous_standby]
    assert config[:enforce_production_boot_checks]
    assert config[:require_production_auth]
    assert config[:stateholder] == ChalkSync.Stateholder.Postgres
    assert config[:token_verifier] == ChalkSync.Auth.JWTTokenVerifier
  end

  test "invalid standby settings fail closed" do
    for value <- ["", "FALSE", "0", "disabled"] do
      System.put_env("CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY", value)

      assert_raise RuntimeError,
                   "CHALK_SYNC_REQUIRE_SYNCHRONOUS_STANDBY must be true or false",
                   fn ->
                     read_config()
                   end
    end
  end

  defp read_config do
    "config/runtime.exs"
    |> Config.Reader.read!(env: :prod, target: :host)
    |> Keyword.fetch!(:chalk_sync)
  end
end
