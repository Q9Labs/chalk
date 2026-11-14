defmodule ChalkSync.HostEnvContractTest do
  # The host environment contracts (infrastructure/managed-episode/env) document every variable the controller
  # renders into the host. A release that makes a new variable required would otherwise first fail on the host, so
  # each contract must pass config/runtime.exs as it stands. A value an operator supplies from the secret store is
  # replaced by a well-formed stand-in.
  use ExUnit.Case, async: false

  @contracts Path.expand("../../../../infrastructure/managed-episode/env", __DIR__)
  @runtime Path.expand("../../config/runtime.exs", __DIR__)

  # The loader must see only the contract: a variable the CI job exports would hide one the contract lacks.
  setup do
    inherited = chalk_env()
    Enum.each(Map.keys(inherited), &System.delete_env/1)

    on_exit(fn ->
      Enum.each(Map.keys(chalk_env()), &System.delete_env/1)
      Enum.each(inherited, fn {key, value} -> System.put_env(key, value) end)
    end)
  end

  for name <- ["sync.nightly.env.example", "sync.env.example"] do
    test "#{name} passes the production runtime configuration" do
      unquote(name)
      |> read_contract()
      |> Enum.each(fn {key, value} -> System.put_env(key, stand_in(key, value)) end)

      assert Config.Reader.read!(@runtime, env: :prod, target: :host)
             |> Keyword.has_key?(:chalk_sync)
    end
  end

  defp chalk_env do
    System.get_env()
    |> Enum.filter(fn {key, _value} -> String.starts_with?(key, "CHALK_") end)
    |> Map.new()
  end

  defp read_contract(name) do
    @contracts
    |> Path.join(name)
    |> File.read!()
    |> String.split("\n", trim: true)
    |> Enum.reject(&(String.starts_with?(&1, "#") or String.trim(&1) == ""))
    |> Map.new(fn line ->
      [key, value] = String.split(line, "=", parts: 2)
      {key, value}
    end)
  end

  defp stand_in(key, value) do
    cond do
      not String.contains?(value, "__") ->
        value

      key == "CHALK_DATABASE_URL" ->
        "postgres://contract:contract@db.invalid:5432/chalk?sslmode=verify-full"

      key == "CHALK_SYNC_TOKEN_PUBLIC_KEYS" ->
        JSON.encode!(%{
          "contract-value" => Base.url_encode64(:binary.copy(<<1>>, 32), padding: false)
        })

      true ->
        "contract-value"
    end
  end
end
