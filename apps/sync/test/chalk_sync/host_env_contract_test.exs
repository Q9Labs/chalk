defmodule ChalkSync.HostEnvContractTest do
  # The host environment contracts (infrastructure/managed-episode/env) document every variable the controller renders into the
  # host. A release that makes a new variable required would otherwise first fail on the host, so each contract must pass
  # config/runtime.exs as it stands. A value an operator supplies from the secret store is replaced by a well-formed stand-in.
  use ExUnit.Case, async: false

  @contracts Path.expand("../../../../infrastructure/managed-episode/env", __DIR__)
  @runtime Path.expand("../../config/runtime.exs", __DIR__)

  for name <- ["sync.nightly.env.example", "sync.env.example"] do
    test "#{name} passes the production runtime configuration" do
      values = read_contract(unquote(name))
      previous = Map.new(values, fn {key, _value} -> {key, System.get_env(key)} end)

      try do
        Enum.each(values, fn {key, value} -> System.put_env(key, stand_in(key, value)) end)

        assert Config.Reader.read!(@runtime, env: :prod, target: :host)
               |> Keyword.has_key?(:chalk_sync)
      after
        Enum.each(previous, fn
          {key, nil} -> System.delete_env(key)
          {key, value} -> System.put_env(key, value)
        end)
      end
    end
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
