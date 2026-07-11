defmodule ChalkSync.SyncBreaker.Checker do
  @moduledoc """
  Offline safety checker for materialized sync-breaker histories.

  Each public check returns `:ok` or `{:error, %Failure{}}`. `check/1` runs the
  complete invariant set in a stable order and stops at the first failure.
  """

  alias ChalkSync.SyncBreaker.Checker.Failure
  alias ChalkSync.SyncBreaker.Checker.Idempotency
  alias ChalkSync.SyncBreaker.Checker.Replay
  alias ChalkSync.SyncBreaker.History.Record
  alias ChalkSync.SyncBreaker.Model

  @type result :: :ok | {:error, Failure.t()}

  @spec check([Record.t()]) :: result()
  def check(records) do
    Enum.reduce_while(
      [
        &check_revision_continuity/1,
        &check_model_convergence/1,
        &check_ack_event_correlation/1,
        &check_rejected_no_mutation/1,
        &check_replay_snapshot_equivalence/1,
        &check_idempotency/1
      ],
      :ok,
      fn checker, :ok ->
        case checker.(records) do
          :ok -> {:cont, :ok}
          {:error, _failure} = failure -> {:halt, failure}
        end
      end
    )
  end

  @spec check_revision_continuity([Record.t()]) :: result()
  def check_revision_continuity(records) do
    records
    |> event_records()
    |> Enum.reduce_while({:ok, 0}, fn record, {:ok, previous_revision} ->
      base_revision = event_value(record.event, :base_revision)
      revision = event_value(record.event, :revision)

      if base_revision == previous_revision and revision == base_revision + 1 do
        {:cont, {:ok, revision}}
      else
        {:halt,
         failure(
           :revision_continuity,
           record,
           "event revisions must form a gap-free base_revision -> revision chain",
           %{
             previous_revision: previous_revision,
             base_revision: base_revision,
             revision: revision
           }
         )}
      end
    end)
    |> result_from_reduction()
  end

  @spec check_model_convergence([Record.t()]) :: result()
  def check_model_convergence(records) do
    with :ok <- check_revision_continuity(records) do
      records
      |> ordered()
      |> Enum.reduce_while({:ok, Model.new()}, fn record, {:ok, state} ->
        advance_model(record, state)
      end)
      |> result_from_reduction()
    end
  end

  @spec check_ack_event_correlation([Record.t()]) :: result()
  def check_ack_event_correlation(records) do
    events = event_records(records)

    records
    |> completed_records()
    |> Enum.reduce_while(:ok, fn record, :ok ->
      check_ack_record(record, events)
    end)
    |> result_from_reduction()
  end

  @spec check_rejected_no_mutation([Record.t()]) :: result()
  def check_rejected_no_mutation(records) do
    events = event_records(records)

    records
    |> completed_records()
    |> Enum.reduce_while(:ok, fn record, :ok ->
      check_rejected_record(record, events)
    end)
    |> result_from_reduction()
  end

  @spec check_replay_snapshot_equivalence([Record.t()]) :: result()
  def check_replay_snapshot_equivalence(records), do: Replay.check(records)

  @spec check_idempotency([Record.t()]) :: result()
  def check_idempotency(records), do: Idempotency.check(records)

  defp completed_records(records),
    do: records |> ordered() |> Enum.filter(&(&1.kind == :complete))

  defp event_records(records), do: records |> ordered() |> Enum.filter(&(&1.kind == :event))
  defp ordered(records), do: Enum.sort_by(records, & &1.seq)

  defp advance_model(%Record{kind: :event, event: event} = record, state) do
    case Model.apply_event(state, event) do
      {:ok, next_state} ->
        {:cont, {:ok, next_state}}

      {:error, reason} ->
        {:halt,
         failure(
           :model_convergence,
           record,
           "event cannot advance the independent model",
           %{reason: reason}
         )}
    end
  end

  defp advance_model(%Record{kind: :snapshot, snapshot: snapshot} = record, state) do
    if Model.snapshot_matches?(state, snapshot) do
      {:cont, {:ok, state}}
    else
      {:halt,
       failure(
         :model_convergence,
         record,
         "snapshot differs from the model reconstructed from committed events"
       )}
    end
  end

  defp advance_model(_record, state), do: {:cont, {:ok, state}}

  defp check_ack_record(record, events) do
    case outcome(record.outcome) do
      {:committed, revision} -> check_committed_ack(record, events, revision)
      {:duplicate, revision} -> check_duplicate_ack(record, events, revision)
      {:rejected, _reason} -> {:cont, :ok}
      :invalid -> {:halt, invalid_ack_failure(record)}
    end
  end

  defp check_committed_ack(record, events, revision) do
    matches =
      Enum.count(
        events,
        &(&1.operation_id == record.operation_id and
            event_value(&1.event, :revision) == revision)
      )

    ack_match_result(
      record,
      revision,
      matches,
      "a committed acknowledgement must identify exactly one committed event"
    )
  end

  defp check_duplicate_ack(record, events, revision) do
    matches =
      Enum.count(events, fn event ->
        event.actor == record.actor and event.command_id == record.command_id and
          event_value(event.event, :revision) == revision
      end)

    ack_match_result(
      record,
      revision,
      matches,
      "a duplicate acknowledgement must point to the original committed event"
    )
  end

  defp ack_match_result(_record, _revision, 1, _message), do: {:cont, :ok}

  defp ack_match_result(record, revision, matches, message) do
    {:halt,
     failure(:ack_event_correlation, record, message, %{revision: revision, matches: matches})}
  end

  defp invalid_ack_failure(record) do
    failure(
      :ack_event_correlation,
      record,
      "completion has an invalid acknowledgement outcome"
    )
  end

  defp check_rejected_record(record, events) do
    if match?({:rejected, _reason}, outcome(record.outcome)) and
         Enum.any?(events, &(&1.operation_id == record.operation_id)) do
      {:halt,
       failure(
         :rejected_no_mutation,
         record,
         "a rejected operation emitted a committed event"
       )}
    else
      {:cont, :ok}
    end
  end

  defp outcome({result, value}) when result in [:committed, :duplicate, :rejected],
    do: {result, value}

  defp outcome(_outcome), do: :invalid

  defp event_value(event, key), do: Map.get(event, key, Map.get(event, Atom.to_string(key)))

  defp result_from_reduction({:ok, _state}), do: :ok
  defp result_from_reduction(:ok), do: :ok
  defp result_from_reduction({:error, %Failure{} = failure}), do: {:error, failure}
  defp result_from_reduction(%Failure{} = failure), do: {:error, failure}

  defp failure(invariant, record, message, details \\ %{}) do
    %Failure{
      invariant: invariant,
      message: message,
      seq: record && record.seq,
      record: record,
      details: details
    }
  end
end
