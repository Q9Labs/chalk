defmodule ChalkSync.SyncBreaker.Checker.Replay do
  @moduledoc false

  alias ChalkSync.SyncBreaker.Checker
  alias ChalkSync.SyncBreaker.Checker.Failure
  alias ChalkSync.SyncBreaker.Model

  def check(records) do
    with :ok <- Checker.check_revision_continuity(records),
         {:ok, states} <- states_by_revision(records) do
      records
      |> ordered()
      |> Enum.filter(&(&1.kind == :replay))
      |> Enum.reduce_while(:ok, fn record, :ok -> check_record(record, states, records) end)
      |> result_from_reduction()
    else
      {:error, %Failure{} = failure} -> {:error, failure}
    end
  end

  defp check_record(record, states, records) do
    expected_events = authoritative_suffix(records, record.cursor, record.control_revision)

    with {:ok, base_state} <- Map.fetch(states, record.cursor),
         true <- canonical_events(record.events || []) == expected_events,
         {:ok, replayed} <- Model.replay(base_state, record.events || []),
         true <- replayed.revision == record.control_revision,
         true <- Model.snapshot_matches?(replayed, record.snapshot),
         {:ok, authoritative} <- Map.fetch(states, record.control_revision),
         true <- Model.snapshot(authoritative) == Model.snapshot(replayed) do
      {:cont, :ok}
    else
      _ ->
        {:halt,
         failure(
           record,
           "replay must be the exact authoritative suffix and reconstruct its snapshot"
         )}
    end
  end

  defp states_by_revision(records) do
    event_records(records)
    |> Enum.reduce_while({:ok, %{0 => Model.new()}}, fn record, {:ok, states} ->
      previous_revision = event_value(record.event, :base_revision)

      with {:ok, state} <- Map.fetch(states, previous_revision),
           {:ok, next_state} <- Model.apply_event(state, record.event) do
        {:cont, {:ok, Map.put(states, next_state.revision, next_state)}}
      else
        _ -> {:halt, :error}
      end
    end)
    |> case do
      {:ok, states} -> {:ok, states}
      :error -> {:error, failure(nil, "event history cannot reconstruct replay starting states")}
    end
  end

  defp event_records(records), do: records |> ordered() |> Enum.filter(&(&1.kind == :event))
  defp ordered(records), do: Enum.sort_by(records, & &1.seq)
  defp event_value(event, key), do: Map.get(event, key, Map.get(event, Atom.to_string(key)))

  defp authoritative_suffix(records, cursor, control_revision) do
    records
    |> event_records()
    |> Enum.map(& &1.event)
    |> Enum.filter(fn event ->
      revision = event_value(event, :revision)
      revision > cursor and revision <= control_revision
    end)
    |> canonical_events()
  end

  defp canonical_events(events), do: Enum.map(events, &canonical_event/1)

  defp canonical_event(event) do
    %{
      "name" => event_value(event, :name),
      "base_revision" => event_value(event, :base_revision),
      "revision" => event_value(event, :revision),
      "payload" => canonical_value(event_value(event, :payload))
    }
  end

  defp canonical_value(map) when is_map(map) do
    Map.new(map, fn {key, value} -> {to_string(key), canonical_value(value)} end)
  end

  defp canonical_value(list) when is_list(list), do: Enum.map(list, &canonical_value/1)
  defp canonical_value(value), do: value

  defp result_from_reduction(:ok), do: :ok
  defp result_from_reduction(%Failure{} = failure), do: {:error, failure}

  defp failure(record, message) do
    %Failure{
      invariant: :replay_snapshot_equivalence,
      message: message,
      seq: record && record.seq,
      record: record
    }
  end
end
