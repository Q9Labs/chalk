defmodule ChalkSync.Retention.CleanupWorker do
  @moduledoc """
  Verifies and removes expired Episode history in bounded PostgreSQL batches.

  Each batch claims only ended Episodes outside the seven-day retention window.
  `SKIP LOCKED` lets concurrent workers make progress without waiting. Every
  claimed control row remains locked while its event log is independently
  folded in bounded pages, checkpointed, and deleted in foreign-key order.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Retention.SQL
  alias ChalkSync.UUID

  @retention_seconds 7 * 24 * 60 * 60
  @default_batch_size 4
  @maximum_batch_size 16
  @event_page_size 256

  defmodule Result do
    @moduledoc "Cleanup counters for one committed worker batch."

    defstruct episodes: 0,
              event_rows: 0,
              event_bytes: 0,
              receipt_rows: 0,
              receipt_bytes: 0,
              lifecycle_intent_rows: 0,
              lifecycle_intent_bytes: 0,
              external_operation_rows: 0,
              external_operation_bytes: 0,
              admission_request_rows: 0,
              admission_request_bytes: 0,
              recording_rows: 0,
              recording_bytes: 0,
              screen_share_lease_rows: 0,
              screen_share_lease_bytes: 0,
              publication_fence_rows: 0,
              publication_fence_bytes: 0,
              publication_grant_reservation_rows: 0,
              publication_grant_reservation_bytes: 0

    @type t :: %__MODULE__{
            episodes: non_neg_integer(),
            event_rows: non_neg_integer(),
            event_bytes: non_neg_integer(),
            receipt_rows: non_neg_integer(),
            receipt_bytes: non_neg_integer(),
            lifecycle_intent_rows: non_neg_integer(),
            lifecycle_intent_bytes: non_neg_integer(),
            external_operation_rows: non_neg_integer(),
            external_operation_bytes: non_neg_integer(),
            admission_request_rows: non_neg_integer(),
            admission_request_bytes: non_neg_integer(),
            recording_rows: non_neg_integer(),
            recording_bytes: non_neg_integer(),
            screen_share_lease_rows: non_neg_integer(),
            screen_share_lease_bytes: non_neg_integer(),
            publication_fence_rows: non_neg_integer(),
            publication_fence_bytes: non_neg_integer(),
            publication_grant_reservation_rows: non_neg_integer(),
            publication_grant_reservation_bytes: non_neg_integer()
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

      Postgrex.query!(transaction, SQL.claim_eligible_episodes(), [cutoff, now, batch_size])
      |> Map.fetch!(:rows)
      |> Enum.reduce(%Result{}, fn row, result ->
        cleanup_candidate(transaction, candidate(row), now, result)
      end)
    end)
  end

  defp cleanup_candidate(transaction, candidate, now, result) do
    case verify_history(transaction, candidate) do
      {:ok, event_count, event_bytes} ->
        external_operations =
          measurement(transaction, SQL.measure_terminal_external_operations(), candidate)

        receipt_rows = delete_count(transaction, SQL.delete_receipts(), candidate)

        lifecycle_intent_rows =
          delete_count(transaction, SQL.delete_terminal_lifecycle_intents(), candidate)

        clear_terminal_operation_event_links(transaction, candidate)
        event_rows = delete_count(transaction, SQL.delete_events(), candidate)

        admission_requests =
          delete_measurement(transaction, SQL.delete_admission_requests(), candidate)

        recordings = delete_measurement(transaction, SQL.delete_recordings(), candidate)

        publication_fences =
          delete_measurement(transaction, SQL.delete_publication_fences(), candidate)

        grant_reservations =
          delete_measurement(transaction, SQL.delete_publication_grant_reservations(), candidate)

        screen_share_leases =
          delete_measurement(transaction, SQL.delete_screen_share_leases(), candidate)

        external_operation_rows =
          delete_count(transaction, SQL.delete_terminal_external_operations(), candidate)

        delete_collaboration_data(transaction, candidate)

        if receipt_rows != candidate.receipt_count or
             lifecycle_intent_rows != candidate.lifecycle_intent_count or
             event_rows != event_count or
             external_operation_rows != elem(external_operations, 0) do
          Postgrex.rollback(transaction, {:invalid_history, :cleanup_counter_mismatch})
        end

        measurements = %{
          external_operations: external_operations,
          admission_requests: admission_requests,
          recordings: recordings,
          screen_share_leases: screen_share_leases,
          publication_fences: publication_fences,
          grant_reservations: grant_reservations
        }

        write_checkpoint(
          transaction,
          candidate,
          now,
          event_count,
          event_bytes,
          measurements
        )

        %Result{
          episodes: result.episodes + 1,
          event_rows: result.event_rows + event_rows,
          event_bytes: result.event_bytes + event_bytes,
          receipt_rows: result.receipt_rows + receipt_rows,
          receipt_bytes: result.receipt_bytes + candidate.receipt_bytes,
          lifecycle_intent_rows: result.lifecycle_intent_rows + lifecycle_intent_rows,
          lifecycle_intent_bytes:
            result.lifecycle_intent_bytes + candidate.lifecycle_intent_bytes,
          external_operation_rows: result.external_operation_rows + elem(external_operations, 0),
          external_operation_bytes:
            result.external_operation_bytes + elem(external_operations, 1),
          admission_request_rows: result.admission_request_rows + elem(admission_requests, 0),
          admission_request_bytes: result.admission_request_bytes + elem(admission_requests, 1),
          recording_rows: result.recording_rows + elem(recordings, 0),
          recording_bytes: result.recording_bytes + elem(recordings, 1),
          screen_share_lease_rows: result.screen_share_lease_rows + elem(screen_share_leases, 0),
          screen_share_lease_bytes:
            result.screen_share_lease_bytes + elem(screen_share_leases, 1),
          publication_fence_rows: result.publication_fence_rows + elem(publication_fences, 0),
          publication_fence_bytes: result.publication_fence_bytes + elem(publication_fences, 1),
          publication_grant_reservation_rows:
            result.publication_grant_reservation_rows + elem(grant_reservations, 0),
          publication_grant_reservation_bytes:
            result.publication_grant_reservation_bytes + elem(grant_reservations, 1)
        }

      {:error, reason} ->
        Postgrex.rollback(transaction, {:invalid_history, reason})
    end
  end

  defp verify_history(transaction, candidate) do
    state =
      Reducer.new(UUID.load!(candidate.episode_id), %{
        config_snapshot: candidate.config_snapshot
      })

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
             {:ok, next} <- Reducer.apply_event(current, event),
             true <- Reducer.digest(next) == digest do
          {:cont, {:ok, next, count + 1, bytes + encoded_bytes}}
        else
          {:error, reason} -> {:halt, {:error, reason}}
          false -> {:halt, {:error, :event_digest_mismatch}}
        end
    end)
  end

  defp write_checkpoint(transaction, candidate, now, event_count, event_bytes, measurements) do
    params = [
      candidate.tenant_id,
      candidate.episode_id,
      candidate.control_revision,
      candidate.state_digest,
      event_count,
      now,
      event_bytes,
      candidate.receipt_count,
      candidate.receipt_bytes,
      candidate.lifecycle_intent_count,
      candidate.lifecycle_intent_bytes,
      elem(measurements.external_operations, 0),
      elem(measurements.external_operations, 1),
      elem(measurements.admission_requests, 0),
      elem(measurements.admission_requests, 1),
      elem(measurements.recordings, 0),
      elem(measurements.recordings, 1),
      elem(measurements.screen_share_leases, 0),
      elem(measurements.screen_share_leases, 1),
      elem(measurements.publication_fences, 0),
      elem(measurements.publication_fences, 1),
      elem(measurements.grant_reservations, 0),
      elem(measurements.grant_reservations, 1)
    ]

    case Postgrex.query!(transaction, SQL.write_checkpoint(), params).rows do
      [[_episode_id]] -> :ok
      [] -> Postgrex.rollback(transaction, {:invalid_history, :checkpoint_race})
    end
  end

  defp delete_count(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, [candidate.tenant_id, candidate.episode_id]).rows do
      [[count]] -> count
    end
  end

  defp delete_measurement(transaction, query, candidate) do
    measurement(transaction, query, candidate)
  end

  defp measurement(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, [candidate.tenant_id, candidate.episode_id]).rows do
      [[rows, bytes]] -> {rows, bytes}
    end
  end

  defp clear_terminal_operation_event_links(transaction, candidate) do
    Postgrex.query!(transaction, SQL.clear_terminal_operation_event_links(), [
      candidate.tenant_id,
      candidate.episode_id
    ])
  end

  defp delete_collaboration_data(transaction, candidate) do
    collaboration_deletions = [
      SQL.delete_chat_read_receipts(),
      SQL.delete_chat_messages(),
      SQL.delete_chat_streams(),
      SQL.delete_whiteboard_operation_receipts(),
      SQL.delete_whiteboard_permissions(),
      SQL.delete_whiteboard_elements(),
      SQL.delete_whiteboard_scenes()
    ]

    Enum.each(collaboration_deletions, fn query ->
      _measurement = delete_measurement(transaction, query, candidate)
    end)
  end

  defp candidate([
         tenant_id,
         space_id,
         episode_id,
         config_snapshot,
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
      space_id: space_id,
      episode_id: episode_id,
      config_snapshot: config_snapshot,
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
