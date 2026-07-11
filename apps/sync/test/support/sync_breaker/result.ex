defmodule ChalkSync.SyncBreaker.Result do
  @moduledoc false

  @enforce_keys [:scenario, :status]
  defstruct [:scenario, :status, :seed, :invariant, :message, evidence: %{}, trace: []]

  def pass(scenario, opts \\ []) do
    struct!(__MODULE__, Keyword.merge([scenario: scenario, status: :pass], opts))
  end

  def fail(scenario, invariant, message, opts \\ []) do
    struct!(
      __MODULE__,
      Keyword.merge(
        [
          scenario: scenario,
          status: :fail,
          invariant: invariant,
          message: normalize_message(message)
        ],
        opts
      )
    )
  end

  def error(scenario, exception, opts \\ []) do
    message = Exception.format(:error, exception, opts[:stacktrace] || [])
    opts = opts |> Keyword.delete(:stacktrace) |> Keyword.put(:message, message)
    struct!(__MODULE__, Keyword.merge([scenario: scenario, status: :error], opts))
  end

  def to_map(%__MODULE__{} = result) do
    json_value(%{
      "scenario" => result.scenario,
      "status" => Atom.to_string(result.status),
      "seed" => result.seed,
      "invariant" => stringify(result.invariant),
      "message" => result.message,
      "evidence" => result.evidence,
      "trace" => result.trace
    })
  end

  defp stringify(nil), do: nil
  defp stringify(value) when is_atom(value), do: Atom.to_string(value)
  defp stringify(value), do: to_string(value)

  defp normalize_message(message) when is_binary(message), do: message

  defp normalize_message(message),
    do: inspect(message, limit: :infinity, printable_limit: :infinity)

  defp json_value(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), json_value(value)} end)
  end

  defp json_value(list) when is_list(list), do: Enum.map(list, &json_value/1)

  defp json_value(tuple) when is_tuple(tuple),
    do: tuple |> Tuple.to_list() |> Enum.map(&json_value/1)

  defp json_value(value) when is_pid(value) or is_reference(value), do: inspect(value)
  defp json_value(value) when is_boolean(value) or is_nil(value), do: value
  defp json_value(value) when is_atom(value), do: Atom.to_string(value)
  defp json_value(value), do: value
end
