defmodule ChalkSync.SyncBreaker.Checker.Idempotency do
  @moduledoc false

  alias ChalkSync.SyncBreaker.Checker.Failure

  def check(records) do
    records
    |> completed_records()
    |> Enum.group_by(&{&1.actor, &1.command_id})
    |> Enum.sort_by(fn {key, _completions} -> key end)
    |> Enum.reduce_while(:ok, fn {_key, completions}, :ok ->
      check_completion_group(completions, records)
    end)
    |> result_from_reduction()
  end

  defp check_completion_group([_single], _records), do: {:cont, :ok}

  defp check_completion_group([first | retries], records) do
    case check_retries(first, retries, records) do
      :ok -> {:cont, :ok}
      {:error, failure} -> {:halt, failure}
    end
  end

  defp check_retries(first, retries, records) do
    case outcome(first.outcome) do
      {:committed, revision} ->
        check_retries(
          retries,
          records,
          {:duplicate, revision},
          "a retried committed command must duplicate its original revision without another event"
        )

      {:rejected, reason} ->
        check_retries(
          retries,
          records,
          {:rejected, reason},
          "a retried rejected command must remain rejected without an event"
        )

      :invalid ->
        {:error,
         failure(first, "initial command completion has an invalid acknowledgement outcome")}
    end
  end

  defp check_retries(retries, records, expected_outcome, message) do
    retries
    |> Enum.reduce_while(:ok, fn retry, :ok ->
      retry_events = Enum.filter(event_records(records), &(&1.operation_id == retry.operation_id))

      if outcome(retry.outcome) == expected_outcome and retry_events == [] do
        {:cont, :ok}
      else
        {:halt, failure(retry, message)}
      end
    end)
    |> result_from_reduction()
  end

  defp completed_records(records),
    do: records |> ordered() |> Enum.filter(&(&1.kind == :complete))

  defp event_records(records), do: records |> ordered() |> Enum.filter(&(&1.kind == :event))
  defp ordered(records), do: Enum.sort_by(records, & &1.seq)

  defp outcome({result, value}) when result in [:committed, :duplicate, :rejected],
    do: {result, value}

  defp outcome(_outcome), do: :invalid
  defp result_from_reduction(:ok), do: :ok
  defp result_from_reduction(%Failure{} = failure), do: {:error, failure}

  defp failure(record, message) do
    %Failure{invariant: :idempotency, message: message, seq: record.seq, record: record}
  end
end
