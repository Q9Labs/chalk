defmodule ChalkSync.ReleaseTopology.Schedule do
  @moduledoc false

  alias ChalkSync.CanonicalJSON

  @schema_version 1
  @environments ["local", "staging"]
  @action_expectations %{
    "trigger_check" => "confirmed",
    "inject" => "injected",
    "observe" => "confirmed",
    "telemetry" => "available",
    "cleanup" => "cleaned"
  }
  @top_level_keys ~w(schema_version name environment topology topology_check breaker events)
  @topology_keys ~w(release_artifact_sha256 configuration_sha256 topology_sha256 protocol_version)

  @event_keys [
    "id",
    "trigger",
    "duration_ms",
    "expected_readiness",
    "expected_client_outcome",
    "recovery_deadline_ms",
    "invariants",
    "trigger_check",
    "inject",
    "observe",
    "telemetry",
    "cleanup"
  ]

  @max_events 24
  @max_schedule_bytes 262_144
  @max_duration_ms 900_000
  @max_recovery_deadline_ms 1_800_000
  @max_command_timeout_ms 28_800_000
  @max_argv 64
  @max_arg_bytes 1_024
  @safe_identifier ~r/\A[a-z][a-z0-9_]{2,63}\z/
  @sha256 ~r/\A[a-f0-9]{64}\z/
  @sensitive_terms ~w(token secret password authorization cookie private_key api_key database_url bearer)

  def schema_version, do: @schema_version

  def load(path) do
    with {:ok, contents} <- read_bounded(path),
         {:ok, schedule} <- JSON.decode(contents) do
      validate(schedule)
    else
      {:error, reason} -> {:error, "could not load schedule: #{format_reason(reason)}"}
    end
  end

  defp read_bounded(path) do
    with {:ok, file} <- File.open(path, [:read, :binary]) do
      result =
        case IO.binread(file, @max_schedule_bytes + 1) do
          contents when is_binary(contents) and byte_size(contents) <= @max_schedule_bytes ->
            {:ok, contents}

          contents when is_binary(contents) ->
            {:error, "schedule exceeds #{@max_schedule_bytes} bytes"}

          :eof ->
            {:ok, ""}

          {:error, reason} ->
            {:error, reason}
        end

      File.close(file)
      result
    end
  end

  def validate(schedule) when is_map(schedule) do
    with :ok <- exact_keys(schedule, @top_level_keys, "schedule"),
         :ok <- equal(Map.fetch!(schedule, "schema_version"), @schema_version, "schema_version"),
         {:ok, name} <- identifier(Map.fetch!(schedule, "name"), "name"),
         :ok <- member(Map.fetch!(schedule, "environment"), @environments, "environment"),
         {:ok, topology} <- topology(Map.fetch!(schedule, "topology")),
         {:ok, topology_check} <- topology_check(Map.fetch!(schedule, "topology_check")),
         {:ok, breaker} <- breaker(Map.fetch!(schedule, "breaker")),
         {:ok, events} <- events(Map.fetch!(schedule, "events")) do
      {:ok,
       %{
         "schema_version" => @schema_version,
         "name" => name,
         "environment" => Map.fetch!(schedule, "environment"),
         "topology" => topology,
         "topology_check" => topology_check,
         "breaker" => breaker,
         "events" => events
       }}
    end
  end

  def validate(_schedule), do: {:error, "schedule must be a JSON object"}

  def digest(schedule) do
    schedule
    |> CanonicalJSON.encode!()
    |> then(&:crypto.hash(:sha256, &1))
    |> Base.encode16(case: :lower)
  end

  def sanitized(schedule) do
    %{
      "schema_version" => schedule["schema_version"],
      "name" => schedule["name"],
      "environment" => schedule["environment"],
      "topology" => schedule["topology"],
      "topology_check" => action_reference(schedule["topology_check"]),
      "breaker" => action_reference(schedule["breaker"]),
      "events" => Enum.map(schedule["events"], &sanitized_event/1)
    }
  end

  defp topology(value) when is_map(value) do
    with :ok <- exact_keys(value, @topology_keys, "topology"),
         :ok <- sha256(Map.fetch!(value, "release_artifact_sha256"), "release_artifact_sha256"),
         :ok <- sha256(Map.fetch!(value, "configuration_sha256"), "configuration_sha256"),
         :ok <- sha256(Map.fetch!(value, "topology_sha256"), "topology_sha256"),
         :ok <- positive_integer(Map.fetch!(value, "protocol_version"), "protocol_version", 99) do
      {:ok, Map.take(value, @topology_keys)}
    end
  end

  defp topology(_value), do: {:error, "topology must be an object"}

  defp topology_check(value) when is_map(value) do
    with :ok <- exact_keys(value, ~w(argv timeout_ms expect), "topology_check"),
         {:ok, valid_argv} <- argv(Map.fetch!(value, "argv"), "topology_check.argv"),
         :ok <-
           positive_integer(
             Map.fetch!(value, "timeout_ms"),
             "topology_check.timeout_ms",
             @max_command_timeout_ms
           ),
         :ok <- equal(Map.fetch!(value, "expect"), "confirmed", "topology_check.expect") do
      {:ok,
       %{
         "argv" => valid_argv,
         "timeout_ms" => Map.fetch!(value, "timeout_ms"),
         "expect" => "confirmed"
       }}
    end
  end

  defp topology_check(_value), do: {:error, "topology_check must be an object"}

  defp breaker(value) when is_map(value) do
    with :ok <- exact_keys(value, ~w(argv timeout_ms), "breaker"),
         {:ok, argv} <- argv(Map.fetch!(value, "argv"), "breaker.argv"),
         :ok <-
           positive_integer(
             Map.fetch!(value, "timeout_ms"),
             "breaker.timeout_ms",
             @max_command_timeout_ms
           ) do
      {:ok, %{"argv" => argv, "timeout_ms" => Map.fetch!(value, "timeout_ms")}}
    end
  end

  defp breaker(_value), do: {:error, "breaker must be an object"}

  defp events(events) when is_list(events) and length(events) in 1..@max_events do
    events
    |> Enum.with_index(1)
    |> Enum.reduce_while({:ok, []}, fn {event, index}, {:ok, valid_events} ->
      case event(event, index) do
        {:ok, valid_event} -> {:cont, {:ok, [valid_event | valid_events]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, valid_events} ->
        valid_events = Enum.reverse(valid_events)

        case duplicate_event_id(valid_events) do
          nil -> {:ok, valid_events}
          id -> {:error, "event id is duplicated: #{id}"}
        end

      error ->
        error
    end
  end

  defp events(_events), do: {:error, "events must contain from 1 to #{@max_events} entries"}

  defp event(value, index) when is_map(value) do
    prefix = "events[#{index}]"

    with :ok <- exact_keys(value, @event_keys, prefix),
         {:ok, id} <- identifier(Map.fetch!(value, "id"), "#{prefix}.id"),
         {:ok, trigger} <- identifier(Map.fetch!(value, "trigger"), "#{prefix}.trigger"),
         :ok <-
           positive_integer(
             Map.fetch!(value, "duration_ms"),
             "#{prefix}.duration_ms",
             @max_duration_ms
           ),
         {:ok, readiness} <-
           identifier(Map.fetch!(value, "expected_readiness"), "#{prefix}.expected_readiness"),
         {:ok, outcome} <-
           identifier(
             Map.fetch!(value, "expected_client_outcome"),
             "#{prefix}.expected_client_outcome"
           ),
         :ok <-
           positive_integer(
             Map.fetch!(value, "recovery_deadline_ms"),
             "#{prefix}.recovery_deadline_ms",
             @max_recovery_deadline_ms
           ),
         {:ok, invariants} <- invariants(Map.fetch!(value, "invariants"), prefix),
         {:ok, trigger_check} <-
           action(Map.fetch!(value, "trigger_check"), prefix, "trigger_check"),
         {:ok, inject} <- action(Map.fetch!(value, "inject"), prefix, "inject"),
         {:ok, observe} <- action(Map.fetch!(value, "observe"), prefix, "observe"),
         {:ok, telemetry} <- action(Map.fetch!(value, "telemetry"), prefix, "telemetry"),
         {:ok, cleanup} <- action(Map.fetch!(value, "cleanup"), prefix, "cleanup") do
      {:ok,
       %{
         "id" => id,
         "trigger" => trigger,
         "duration_ms" => Map.fetch!(value, "duration_ms"),
         "expected_readiness" => readiness,
         "expected_client_outcome" => outcome,
         "recovery_deadline_ms" => Map.fetch!(value, "recovery_deadline_ms"),
         "invariants" => invariants,
         "trigger_check" => trigger_check,
         "inject" => inject,
         "observe" => observe,
         "telemetry" => telemetry,
         "cleanup" => cleanup
       }}
    end
  end

  defp event(_value, index), do: {:error, "events[#{index}] must be an object"}

  defp action(value, prefix, action_name) when is_map(value) do
    scope = "#{prefix}.#{action_name}"
    expected = Map.fetch!(@action_expectations, action_name)

    with :ok <- exact_keys(value, ~w(argv timeout_ms expect), scope),
         {:ok, valid_argv} <- argv(Map.fetch!(value, "argv"), "#{scope}.argv"),
         :ok <-
           positive_integer(
             Map.fetch!(value, "timeout_ms"),
             "#{scope}.timeout_ms",
             @max_command_timeout_ms
           ),
         :ok <- equal(Map.fetch!(value, "expect"), expected, "#{scope}.expect") do
      {:ok,
       %{
         "argv" => valid_argv,
         "timeout_ms" => Map.fetch!(value, "timeout_ms"),
         "expect" => expected
       }}
    end
  end

  defp action(_value, prefix, action_name),
    do: {:error, "#{prefix}.#{action_name} must be an object"}

  defp invariants(values, prefix) when is_list(values) and length(values) in 1..12 do
    values
    |> Enum.reduce_while({:ok, []}, fn value, {:ok, invariants} ->
      case identifier(value, "#{prefix}.invariants") do
        {:ok, invariant} -> {:cont, {:ok, [invariant | invariants]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, valid_invariants} ->
        valid_invariants = Enum.reverse(valid_invariants)

        if Enum.uniq(valid_invariants) == valid_invariants do
          {:ok, valid_invariants}
        else
          {:error, "#{prefix}.invariants must not contain duplicates"}
        end

      error ->
        error
    end
  end

  defp invariants(_values, prefix),
    do: {:error, "#{prefix}.invariants must contain from 1 to 12 entries"}

  defp argv(values, scope) when is_list(values) and length(values) in 1..@max_argv do
    values
    |> Enum.reduce_while({:ok, []}, fn value, {:ok, argv} ->
      case command_argument(value, scope) do
        {:ok, argument} -> {:cont, {:ok, [argument | argv]}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
    |> case do
      {:ok, valid_argv} -> {:ok, Enum.reverse(valid_argv)}
      error -> error
    end
  end

  defp argv(_values, scope),
    do: {:error, "#{scope} must contain from 1 to #{@max_argv} arguments"}

  defp command_argument(value, scope) when is_binary(value) do
    cond do
      value == "" or String.trim(value) != value ->
        {:error, "#{scope} contains an empty or padded argument"}

      byte_size(value) > @max_arg_bytes ->
        {:error, "#{scope} argument exceeds #{@max_arg_bytes} bytes"}

      sensitive?(value) ->
        {:error, "#{scope} must not contain credentials, tokens, URLs, or secret references"}

      true ->
        {:ok, value}
    end
  end

  defp command_argument(_value, scope), do: {:error, "#{scope} arguments must be strings"}

  defp sensitive?(value) do
    normalized = String.downcase(value)

    String.contains?(normalized, "://") or
      Enum.any?(@sensitive_terms, &String.contains?(normalized, &1))
  end

  defp identifier(value, scope) when is_binary(value) do
    if Regex.match?(@safe_identifier, value) do
      {:ok, value}
    else
      {:error, "#{scope} must be a lowercase public-safe identifier"}
    end
  end

  defp identifier(_value, scope),
    do: {:error, "#{scope} must be a lowercase public-safe identifier"}

  defp sha256(value, scope) when is_binary(value) do
    if Regex.match?(@sha256, value),
      do: :ok,
      else: {:error, "#{scope} must be a SHA-256 hex digest"}
  end

  defp sha256(_value, scope), do: {:error, "#{scope} must be a SHA-256 hex digest"}

  defp positive_integer(value, scope, maximum) do
    if is_integer(value) and value > 0 and value <= maximum do
      :ok
    else
      {:error, "#{scope} must be an integer from 1 to #{maximum}"}
    end
  end

  defp equal(value, expected, scope) do
    if value == expected, do: :ok, else: {:error, "#{scope} must equal #{inspect(expected)}"}
  end

  defp member(value, values, scope) do
    if value in values do
      :ok
    else
      {:error, "#{scope} must be one of #{Enum.join(values, ", ")}"}
    end
  end

  defp exact_keys(map, keys, scope) do
    expected = MapSet.new(keys)
    actual = Map.keys(map) |> MapSet.new()

    if actual == expected do
      :ok
    else
      {:error, "#{scope} has unsupported or missing fields"}
    end
  end

  defp duplicate_event_id(events) do
    events
    |> Enum.map(& &1["id"])
    |> Enum.frequencies()
    |> Enum.find_value(fn {id, count} -> if count > 1, do: id end)
  end

  defp sanitized_event(event) do
    %{
      "id" => event["id"],
      "trigger" => event["trigger"],
      "duration_ms" => event["duration_ms"],
      "expected_readiness" => event["expected_readiness"],
      "expected_client_outcome" => event["expected_client_outcome"],
      "recovery_deadline_ms" => event["recovery_deadline_ms"],
      "invariants" => event["invariants"],
      "trigger_check" => action_reference(event["trigger_check"]),
      "inject" => action_reference(event["inject"]),
      "observe" => action_reference(event["observe"]),
      "telemetry" => action_reference(event["telemetry"]),
      "cleanup" => action_reference(event["cleanup"])
    }
  end

  defp action_reference(action) do
    %{
      "argv_sha256" => action |> Map.fetch!("argv") |> Enum.join("\u0000") |> sha256_binary(),
      "timeout_ms" => action["timeout_ms"],
      "expect" => action["expect"]
    }
  end

  defp sha256_binary(value), do: :crypto.hash(:sha256, value) |> Base.encode16(case: :lower)

  defp format_reason(reason) when is_binary(reason), do: reason
  defp format_reason(reason), do: inspect(reason)
end
