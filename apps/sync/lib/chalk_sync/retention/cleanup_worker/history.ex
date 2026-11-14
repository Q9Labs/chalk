defmodule ChalkSync.Retention.CleanupWorker.History do
  @moduledoc """
  Replays an Episode's event history to check it before its data is deleted.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Retention.SQL
  alias ChalkSync.UUID

  @event_page_size 256

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

  defp initial_policy(transaction, candidate) do
    config_policy = %{config_snapshot: candidate.config_snapshot}

    with {:ok, deadline_policy} <- persisted_deadline_policy(candidate),
         true <- terminal_deadline_matches?(candidate, deadline_policy),
         false <- has_deadline_transition?(transaction, candidate) do
      {:ok, Map.merge(config_policy, deadline_policy)}
    else
      :not_usable -> {:ok, config_policy}
      false -> {:ok, config_policy}
      true -> {:ok, config_policy}
    end
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

  defp has_deadline_transition?(transaction, candidate) do
    case Postgrex.query!(transaction, SQL.has_deadline_transition?(), [
           candidate.tenant_id,
           candidate.episode_id
         ]).rows do
      [[value]] -> value
    end
  end

  defp fold_event_pages(transaction, candidate, state, event_count, event_bytes) do
    rows =
      Postgrex.query!(transaction, SQL.read_event_page(), [
        candidate.tenant_id,
        candidate.episode_id,
        state.revision,
        @event_page_size
      ]).rows

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

  defp fold_event_page(rows, state, event_count, event_bytes) do
    Enum.reduce_while(rows, {:ok, state, event_count, event_bytes}, fn
      [base_revision, revision, name, payload, schema_version, digest, encoded_bytes],
      {:ok, current, count, bytes} ->
        event = %{
          base_revision: base_revision,
          revision: revision,
          name: name,
          payload: payload
        }

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
