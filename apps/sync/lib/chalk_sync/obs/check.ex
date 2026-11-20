defmodule ChalkSync.Obs.Check do
  @moduledoc false
  # The registry checks behind every kernel call. Each returns a list of problems; the kernel raises or counts them.

  alias ChalkSync.Obs.Registry

  @spec event_problems(String.t(), String.t(), map()) :: [String.t()]
  def event_problems(name, kind, fields) do
    case Registry.events()[name] do
      nil -> ["unknown event " <> name]
      %{"kind" => ^kind, "fields" => rules} -> field_problems(name, fields, rules)
      %{"kind" => declared} -> ["#{name} is declared as #{declared}, not #{kind}"]
    end
  end

  @spec field_problems(String.t(), map(), map()) :: [String.t()]
  def field_problems(name, fields, rules) do
    given =
      Enum.flat_map(fields, fn {field, value} ->
        spec = Registry.fields()[field]
        rule = rules[field]

        cond do
          spec == nil ->
            ["#{name}: field #{field} is not in the registry"]

          rule == nil and spec["group"] != "trail" ->
            ["#{name}: field #{field} is not declared on this event"]

          fits?(spec["type"], (rule || %{})["values"] || spec["values"], value) ->
            []

          true ->
            [
              "#{name}: field #{field} has #{inspect(value)}, which is not a valid #{spec["type"]}"
            ]
        end
      end)

    missing =
      for {field, %{"required" => true}} <- rules,
          not Map.has_key?(fields, field),
          do: "#{name}: required field #{field} is missing"

    Enum.sort(given ++ missing)
  end

  defp fits?("enum", values, value), do: is_binary(value) and value in values

  defp fits?(type, _values, value) when type in ["string", "id"],
    do: is_binary(value) and value != ""

  defp fits?("int", _values, value), do: is_integer(value)
  defp fits?("number", _values, value), do: is_number(value)
  defp fits?("bool", _values, value), do: is_boolean(value)
  defp fits?("map", _values, value), do: is_map(value)
  defp fits?(_type, _values, _value), do: false

  @spec reason_problems(String.t(), String.t() | nil, String.t() | nil) :: [String.t()]
  def reason_problems(_name, nil, _outcome), do: []

  def reason_problems(name, code, outcome) do
    case Registry.reasons()[code] do
      nil ->
        ["#{name}: unknown reason code #{code}"]

      known when outcome != nil and known != outcome ->
        ["#{name}: reason #{code} is #{known}, not #{outcome}"]

      _known ->
        []
    end
  end

  @spec machine_problems(String.t(), String.t(), String.t(), String.t()) :: [String.t()]
  def machine_problems(machine, from, to, trigger) do
    case Registry.machines()[machine] do
      nil ->
        ["unknown machine " <> machine]

      spec ->
        edge =
          if [from, to] in spec["edges"],
            do: [],
            else: ["#{machine}: #{from} -> #{to} is not a declared edge"]

        trigger_problem =
          if trigger in spec["triggers"],
            do: [],
            else: ["#{machine}: unknown trigger #{trigger}"]

        edge ++ trigger_problem
    end
  end

  @spec decision_problems(String.t(), String.t()) :: [String.t()]
  def decision_problems(name, decision) do
    case Registry.events()[name] do
      %{"decisions" => decisions} ->
        if decision in decisions, do: [], else: ["#{name}: unknown decision #{decision}"]

      _other ->
        []
    end
  end
end
