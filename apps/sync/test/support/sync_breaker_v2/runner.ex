defmodule ChalkSync.SyncBreakerV2.Runner do
  @moduledoc false

  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Memory
  alias ChalkSync.Stateholder.Postgres

  def run(config, adapter, fixtures, timing \\ system_timing()) do
    operations = generate_operations(config, fixtures)
    run_operations(config, adapter, operations, timing)
  end

  def system_timing do
    %{
      now_ms: fn -> System.monotonic_time(:millisecond) end,
      sleep: &Process.sleep/1
    }
  end

  defp generate_operations(config, fixtures) do
    random = :rand.seed_s(:exsplus, {config.seed, config.seed + 1, config.seed + 2})

    {operations, _random} =
      Enum.map_reduce(1..config.operation_count, random, fn index, random ->
        {fixture_index, random} = :rand.uniform_s(length(fixtures), random)
        fixture = Enum.at(fixtures, fixture_index - 1)
        {identity_index, random} = :rand.uniform_s(length(fixture.identities), random)
        {mix_index, random} = :rand.uniform_s(length(config.command_mix), random)

        operation = %{
          index: index,
          identity: Enum.at(fixture.identities, identity_index - 1),
          name: Enum.at(config.command_mix, mix_index - 1),
          command_id: command_id(index, fixture_index)
        }

        {operation, random}
      end)

    operations
  end

  defp run_operations(config, adapter, operations, timing) do
    started_at = timing.now_ms.()

    result =
      operations
      |> Enum.chunk_every(config.burst)
      |> Enum.with_index()
      |> Enum.flat_map(fn {batch, batch_index} ->
        pace(config, started_at, batch_index * config.burst, timing)

        batch
        |> Task.async_stream(&execute_operation(adapter, &1),
          max_concurrency: config.concurrency,
          timeout: 15_000,
          ordered: true
        )
        |> Enum.map(fn
          {:ok, result} -> result
          {:exit, reason} -> {:error, "operation task exited: #{inspect(reason)}", []}
        end)
      end)
      |> Enum.reduce({[], []}, fn
        {:ok, trace}, {outcomes, traces} ->
          {[{:ok, :stable} | outcomes], Enum.reverse(trace, traces)}

        {:error, failure, trace}, {outcomes, traces} ->
          {[{:error, failure} | outcomes], Enum.reverse(trace, traces)}
      end)
      |> then(fn {outcomes, traces} -> {Enum.reverse(outcomes), Enum.reverse(traces)} end)

    wait_for_minimum_duration(config, started_at, timing)
    result
  end

  defp execute_operation(adapter, operation) do
    with {:ok, command} <- Command.new(operation.command_id, operation.name, %{}),
         {:ok, first} <- decide(adapter, operation.identity, command),
         {:ok, retry} <- decide(adapter, operation.identity, command),
         :ok <- stable_retry(first, retry),
         {:ok, conflict_command} <- Command.new(command.id, opposite(command.name), %{}),
         {:ok, conflict} <- decide(adapter, operation.identity, conflict_command),
         :ok <- command_id_conflict(conflict) do
      {:ok,
       [
         trace_decision("decision", operation, first),
         trace_decision("retry", operation, retry),
         trace_decision("conflict", operation, conflict)
       ]}
    else
      {:retryable, reason} ->
        {:error, "decision remained unresolved: #{reason}",
         [operation_failure_trace(operation, reason)]}

      {:error, reason} ->
        {:error, "operation #{operation.index}: #{inspect(reason)}",
         [operation_failure_trace(operation, reason)]}
    end
  end

  defp stable_retry(%{result: :committed} = first, %{result: :duplicate} = retry)
       when first.event_id == retry.event_id and first.revision == retry.revision,
       do: :ok

  defp stable_retry(%{result: :duplicate}, %{result: :duplicate}), do: :ok

  defp stable_retry(%{result: :rejected, reason: reason}, %{result: :rejected, reason: reason}),
    do: :ok

  defp stable_retry(first, retry), do: {:error, {:unstable_retry, first.result, retry.result}}

  defp command_id_conflict(%{result: :command_id_conflict}), do: :ok

  defp command_id_conflict(decision),
    do: {:error, {:missing_command_id_conflict, decision.result}}

  defp decide(adapter, identity, command) do
    case decide_once(adapter, identity, command) do
      {:retryable, _reason} -> decide_once(adapter, identity, command)
      result -> result
    end
  end

  defp decide_once(:memory, identity, command), do: Memory.decide_command(identity, command)
  defp decide_once(:postgres, identity, command), do: Postgres.decide_command(identity, command)

  defp trace_decision(kind, operation, decision) do
    %{
      "kind" => kind,
      "operation" => operation.index,
      "command_id" => operation.command_id,
      "command" => Atom.to_string(operation.name),
      "result" => Atom.to_string(decision.result),
      "event_id" => decision.event_id,
      "revision" => decision.revision,
      "reason" => decision.reason
    }
  end

  defp operation_failure_trace(operation, reason) do
    %{
      "kind" => "operation_failure",
      "operation" => operation.index,
      "command_id" => operation.command_id,
      "command" => Atom.to_string(operation.name),
      "reason" => inspect(reason)
    }
  end

  defp pace(config, started_at, completed_operations, timing) do
    target_ms = started_at + div(completed_operations * 1_000, config.command_rate)
    wait_ms = max(target_ms - timing.now_ms.(), 0)
    if wait_ms > 0, do: timing.sleep.(wait_ms)
  end

  defp wait_for_minimum_duration(%{duration_ms: 0}, _started_at, _timing), do: :ok

  defp wait_for_minimum_duration(config, started_at, timing) do
    wait_until(started_at + config.duration_ms, timing)
  end

  defp wait_until(deadline_ms, timing) do
    case deadline_ms - timing.now_ms.() do
      remaining_ms when remaining_ms > 0 ->
        timing.sleep.(remaining_ms)
        wait_until(deadline_ms, timing)

      _ ->
        :ok
    end
  end

  defp command_id(index, fixture_index), do: "breaker_v2_#{fixture_index}_#{index}_command"
  defp opposite(:raise_hand), do: :lower_hand
  defp opposite(:lower_hand), do: :raise_hand
end
