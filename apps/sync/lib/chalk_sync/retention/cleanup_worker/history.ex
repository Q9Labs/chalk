defmodule ChalkSync.Retention.CleanupWorker.History do
  @moduledoc """
  Replays an Episode's event history to check it before its data is deleted.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Retention.SQL
  alias ChalkSync.UUID

  @event_page_size 256
  # The Episode duration check in the schema bounds a first deadline to 60 seconds up to 7 days after creation.
  @minimum_seconds 60
  @maximum_seconds 604_800

  def verify_history(transaction, candidate) do
    with {:ok, initial_policy} <- initial_policy(transaction, candidate),
         state <- Reducer.new(UUID.load!(candidate.episode_id), initial_policy),
         {:ok, state, event_count, event_bytes} <-
           fold_event_pages(transaction, candidate, state, 0, 0),
         true <- state.status == "ended",
         true <- state.revision == candidate.control_revision,
         true <- event_count == candidate.control_revision,
         true <-
           event_count == candidate.participant_event_count + candidate.lifecycle_event_count,
         true <-
           event_bytes == candidate.participant_event_bytes + candidate.lifecycle_event_bytes,
         true <- candidate.state_schema_version == Reducer.state_schema_version(),
         true <- Reducer.snapshot(state) == candidate.folded_state,
         true <- Reducer.digest(state) == candidate.state_digest do
      {:ok, event_count, event_bytes}
    else
      {:error, reason} -> {:error, reason}
      false -> {:error, :terminal_checkpoint_mismatch}
    end
  end

  # Every digest in the history covers the whole state, including the deadline the Episode started
  # with, so the replay has to start from that deadline.
  defp initial_policy(transaction, candidate) do
    config_policy = %{config_snapshot: candidate.config_snapshot}

    with {:ok, deadline_policy} <- initial_deadline_policy(transaction, candidate) do
      {:ok, Map.merge(config_policy, deadline_policy)}
    else
      :not_usable -> {:ok, config_policy}
    end
  end

  # The control row records the first deadline when the first extension replaces it. Without a record
  # the Episode was either never extended (its current deadline is its first) or was extended before
  # the record existed (the first deadline is found from the digests).
  defp initial_deadline_policy(
         _transaction,
         %{initial_deadline_at_ms: deadline_at_ms, initial_deadline_generation: generation}
       )
       when is_integer(deadline_at_ms) and is_integer(generation),
       do: {:ok, %{deadline_at_ms: deadline_at_ms, deadline_generation: generation}}

  defp initial_deadline_policy(transaction, candidate) do
    with {:ok, deadline_policy} <- persisted_deadline_policy(candidate),
         true <- terminal_deadline_matches?(candidate, deadline_policy) do
      case first_deadline_generation(transaction, candidate) do
        nil -> {:ok, deadline_policy}
        generation -> find_initial_deadline(transaction, candidate, generation - 1)
      end
    else
      _ -> :not_usable
    end
  end

  defp first_deadline_generation(transaction, candidate) do
    case Postgrex.query!(transaction, SQL.first_deadline_generation(), [
           candidate.tenant_id,
           candidate.episode_id
         ]).rows do
      [[generation]] -> generation
      [] -> nil
    end
  end

  # An Episode extended before the first deadline was recorded: its first deadline is taken to be a
  # whole number of minutes after its creation (at most about 30,000 replays). Only a deadline that reproduces the first event's digest is
  # taken, so a changed event still fails the replay that follows.
  defp find_initial_deadline(transaction, candidate, generation) when generation >= 1 do
    [first | _] = event_rows(transaction, candidate, 0, 1)

    state =
      Reducer.new(UUID.load!(candidate.episode_id), %{
        config_snapshot: candidate.config_snapshot,
        deadline_generation: generation
      })

    candidate.deadline_anchors
    |> Enum.map(&DateTime.to_unix(&1, :millisecond))
    |> Enum.uniq()
    |> Stream.flat_map(fn anchor_ms ->
      @minimum_seconds..@maximum_seconds//60
      |> Stream.map(&(anchor_ms + &1 * 1_000))
    end)
    |> Enum.find(&replays_first_event?(%{state | deadline_at_ms: &1}, first))
    |> case do
      nil -> :not_usable
      deadline_at_ms -> {:ok, %{deadline_at_ms: deadline_at_ms, deadline_generation: generation}}
    end
  end

  defp find_initial_deadline(_transaction, _candidate, _generation), do: :not_usable

  defp replays_first_event?(state, row) do
    {event, digest} = event(row)
    match?({:ok, _next}, Reducer.replay_event(state, event, digest))
  end

  defp persisted_deadline_policy(candidate) do
    with %DateTime{} = deadline_at <- candidate.deadline_at,
         deadline_at_ms <- DateTime.to_unix(deadline_at, :millisecond),
         true <- deadline_at_ms >= 1,
         generation when is_integer(generation) and generation >= 1 <-
           candidate.deadline_generation do
      {:ok, %{deadline_at_ms: deadline_at_ms, deadline_generation: generation}}
    else
      _ -> :not_usable
    end
  end

  defp terminal_deadline_matches?(candidate, %{
         deadline_at_ms: deadline_at_ms,
         deadline_generation: generation
       }) do
    candidate.folded_state["deadline_at_ms"] == deadline_at_ms and
      candidate.folded_state["deadline_generation"] == generation
  end

  defp fold_event_pages(transaction, candidate, state, event_count, event_bytes) do
    rows = event_rows(transaction, candidate, state.revision, @event_page_size)

    with {:ok, next_state, next_count, next_bytes} <-
           fold_event_page(rows, state, event_count, event_bytes) do
      if length(rows) == @event_page_size do
        fold_event_pages(
          transaction,
          candidate,
          next_state,
          next_count,
          next_bytes
        )
      else
        {:ok, next_state, next_count, next_bytes}
      end
    end
  end

  defp event_rows(transaction, candidate, after_revision, limit) do
    Postgrex.query!(transaction, SQL.read_event_page(), [
      candidate.tenant_id,
      candidate.episode_id,
      after_revision,
      limit
    ]).rows
  end

  defp event([base_revision, revision, name, payload, _schema_version, digest, _encoded_bytes]),
    do:
      {%{base_revision: base_revision, revision: revision, name: name, payload: payload}, digest}

  defp fold_event_page(rows, state, event_count, event_bytes) do
    Enum.reduce_while(rows, {:ok, state, event_count, event_bytes}, fn row,
                                                                       {:ok, current, count,
                                                                        bytes} ->
      [_base, _revision, _name, _payload, schema_version, _digest, encoded_bytes] = row
      {event, digest} = event(row)

      with true <- schema_version == Reducer.state_schema_version(),
           {:ok, next} <- Reducer.replay_event(current, event, digest) do
        {:cont, {:ok, next, count + 1, bytes + encoded_bytes}}
      else
        {:error, reason} -> {:halt, {:error, reason}}
        false -> {:halt, {:error, :event_digest_mismatch}}
      end
    end)
  end
end
