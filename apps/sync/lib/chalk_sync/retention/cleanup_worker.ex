defmodule ChalkSync.Retention.CleanupWorker do
  @moduledoc """
  Verifies and removes expired Session history in bounded PostgreSQL batches.

  Each batch claims only ended Sessions outside the seven-day retention window.
  `SKIP LOCKED` lets concurrent workers make progress without waiting. Every
  claimed control row remains locked while its event log is independently
  folded in bounded pages, checkpointed, and deleted in foreign-key order.
  """

  alias ChalkSync.Retention.SQL
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.UUID

  @retention_seconds 7 * 24 * 60 * 60
  @default_batch_size 4
  @maximum_batch_size 16
  @event_page_size 256

  defmodule Result do
    @moduledoc "Cleanup counters for one committed worker batch."

    defstruct sessions: 0,
              event_rows: 0,
              event_bytes: 0,
              receipt_rows: 0,
              receipt_bytes: 0,
              lifecycle_intent_rows: 0,
              lifecycle_intent_bytes: 0

    @type t :: %__MODULE__{
            sessions: non_neg_integer(),
            event_rows: non_neg_integer(),
            event_bytes: non_neg_integer(),
            receipt_rows: non_neg_integer(),
            receipt_bytes: non_neg_integer(),
            lifecycle_intent_rows: non_neg_integer(),
            lifecycle_intent_bytes: non_neg_integer()
          }
  end

  @spec run_once(GenServer.server(), keyword()) :: {:ok, Result.t()} | {:error, term()}
  def run_once(connection, options \\ []) do
    batch_size = Keyword.get(options, :batch_size, @default_batch_size)
    clock = Keyword.get(options, :clock, &DateTime.utc_now/0)

    with :ok <- validate_batch_size(batch_size),
         %DateTime{} = now <- clock.() do
      cleanup_batch(connection, batch_size, now)
    else
      _ -> {:error, :invalid_options}
    end
  end

  defp cleanup_batch(connection, batch_size, now) do
    cutoff = DateTime.add(now, -@retention_seconds, :second)

    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, SQL.transaction_settings(), [])

      Postgrex.query!(transaction, SQL.claim_eligible_sessions(), [cutoff, batch_size])
      |> Map.fetch!(:rows)
      |> Enum.reduce(%Result{}, fn row, result ->
        cleanup_candidate(transaction, candidate(row), now, result)
      end)
    end)
  end

  defp cleanup_candidate(transaction, candidate, now, result) do
    case verify_history(transaction, candidate) do
      {:ok, event_count, event_bytes} ->
        write_checkpoint(transaction, candidate, now, event_count, event_bytes)

        receipt_rows = delete_count(transaction, SQL.delete_receipts(), candidate)

        lifecycle_intent_rows =
          delete_count(transaction, SQL.delete_terminal_lifecycle_intents(), candidate)

        event_rows = delete_count(transaction, SQL.delete_events(), candidate)

        if receipt_rows != candidate.receipt_count or
             lifecycle_intent_rows != candidate.lifecycle_intent_count or
             event_rows != event_count do
          Postgrex.rollback(transaction, {:invalid_history, :cleanup_counter_mismatch})
        end

        %Result{
          sessions: result.sessions + 1,
          event_rows: result.event_rows + event_rows,
          event_bytes: result.event_bytes + event_bytes,
          receipt_rows: result.receipt_rows + receipt_rows,
          receipt_bytes: result.receipt_bytes + candidate.receipt_bytes,
          lifecycle_intent_rows: result.lifecycle_intent_rows + lifecycle_intent_rows,
          lifecycle_intent_bytes: result.lifecycle_intent_bytes + candidate.lifecycle_intent_bytes
        }

      {:error, reason} ->
        Postgrex.rollback(transaction, {:invalid_history, reason})
    end
  end

  defp verify_history(transaction, candidate) do
    state = Reducer.new(UUID.load!(candidate.session_id))

    with {:ok, state, event_count, event_bytes} <-
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

  defp fold_event_pages(transaction, candidate, state, event_count, event_bytes) do
    rows =
      Postgrex.query!(transaction, SQL.read_event_page(), [
        candidate.tenant_id,
        candidate.session_id,
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
             {:ok, next} <- Reducer.apply_event(current, event),
             true <- Reducer.digest(next) == digest do
          {:cont, {:ok, next, count + 1, bytes + encoded_bytes}}
        else
          {:error, reason} -> {:halt, {:error, reason}}
          false -> {:halt, {:error, :event_digest_mismatch}}
        end
    end)
  end

  defp write_checkpoint(transaction, candidate, now, event_count, event_bytes) do
    params = [
      candidate.tenant_id,
      candidate.session_id,
      candidate.control_revision,
      candidate.state_digest,
      event_count,
      now,
      event_bytes,
      candidate.receipt_count,
      candidate.receipt_bytes,
      candidate.lifecycle_intent_count,
      candidate.lifecycle_intent_bytes
    ]

    case Postgrex.query!(transaction, SQL.write_checkpoint(), params).rows do
      [[_session_id]] -> :ok
      [] -> Postgrex.rollback(transaction, {:invalid_history, :checkpoint_race})
    end
  end

  defp delete_count(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, [candidate.tenant_id, candidate.session_id]).rows do
      [[count]] -> count
    end
  end

  defp candidate([
         tenant_id,
         room_id,
         session_id,
         control_revision,
         folded_state,
         state_schema_version,
         state_digest,
         participant_event_count,
         participant_event_bytes,
         lifecycle_event_count,
         lifecycle_event_bytes,
         lifecycle_intent_count,
         lifecycle_intent_bytes,
         receipt_count,
         receipt_bytes
       ]) do
    %{
      tenant_id: tenant_id,
      room_id: room_id,
      session_id: session_id,
      control_revision: control_revision,
      folded_state: folded_state,
      state_schema_version: state_schema_version,
      state_digest: state_digest,
      participant_event_count: participant_event_count,
      participant_event_bytes: participant_event_bytes,
      lifecycle_event_count: lifecycle_event_count,
      lifecycle_event_bytes: lifecycle_event_bytes,
      lifecycle_intent_count: lifecycle_intent_count,
      lifecycle_intent_bytes: lifecycle_intent_bytes,
      receipt_count: receipt_count,
      receipt_bytes: receipt_bytes
    }
  end

  defp validate_batch_size(batch_size)
       when is_integer(batch_size) and batch_size > 0 and batch_size <= @maximum_batch_size,
       do: :ok

  defp validate_batch_size(_batch_size), do: {:error, :invalid_batch_size}
end
