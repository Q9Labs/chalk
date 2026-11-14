defmodule ChalkSync.Retention.CleanupWorker do
  @moduledoc """
  Verifies and removes expired Episode history in bounded PostgreSQL batches.

  Each batch claims only ended Episodes outside the seven-day retention window.
  `SKIP LOCKED` lets concurrent workers make progress without waiting. Every
  claimed control row remains locked while its event log is independently
  folded in bounded pages, checkpointed, and deleted in foreign-key order.

  Each Episode is cleaned inside its own savepoint. An Episode whose history
  fails verification rolls back alone, is reported in `Result.held`, and leaves
  the rest of the batch to commit. The caller passes held Episodes back as
  `:excluded_episode_ids`, so one bad history cannot stop the queue behind it.
  """

  alias ChalkSync.Database.TransactionSettings
  alias ChalkSync.Retention.CleanupWorker.Deletion
  alias ChalkSync.Retention.CleanupWorker.History
  alias ChalkSync.Retention.SQL

  @retention_seconds 7 * 24 * 60 * 60
  @default_batch_size 4
  @maximum_batch_size 16
  @measured [
    :external_operations,
    :admission_requests,
    :recordings,
    :screen_share_leases,
    :publication_fences,
    :grant_reservations
  ]

  defmodule Result do
    @moduledoc "Cleanup counters for one committed worker batch."

    defstruct held: [],
              episodes: 0,
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
            held: [{binary(), term()}],
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
    excluded_episode_ids = Keyword.get(options, :excluded_episode_ids, [])

    with :ok <- validate_batch_size(batch_size),
         %DateTime{} = now <- clock.() do
      cleanup_batch(connection, batch_size, excluded_episode_ids, now)
    else
      _ -> {:error, :invalid_options}
    end
  end

  defp cleanup_batch(connection, batch_size, excluded_episode_ids, now) do
    cutoff = DateTime.add(now, -@retention_seconds, :second)

    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, TransactionSettings.sql(:retention), [])

      Postgrex.query!(transaction, SQL.claim_eligible_episodes(), [
        cutoff,
        now,
        batch_size,
        excluded_episode_ids
      ])
      |> Map.fetch!(:rows)
      |> Enum.reduce(%Result{}, fn row, result ->
        cleanup_in_savepoint(transaction, candidate(row), now, result)
      end)
    end)
  end

  defp cleanup_in_savepoint(transaction, candidate, now, result) do
    Postgrex.query!(transaction, "savepoint retention_candidate", [])

    case cleanup_candidate(transaction, candidate, now, result) do
      {:ok, next} ->
        Postgrex.query!(transaction, "release savepoint retention_candidate", [])
        next

      {:error, reason} ->
        Postgrex.query!(transaction, "rollback to savepoint retention_candidate", [])
        %{result | held: [{candidate.episode_id, reason} | result.held]}
    end
  end

  defp cleanup_candidate(transaction, candidate, now, result) do
    case History.verify_history(transaction, candidate) do
      {:ok, event_count, event_bytes} ->
        with {:ok, deleted} <- Deletion.delete_episode(transaction, candidate, event_count) do
          Deletion.write_checkpoint(
            transaction,
            candidate,
            now,
            event_count,
            event_bytes,
            Map.take(deleted, @measured)
          )

          {:ok, tally(result, candidate, event_bytes, deleted)}
        end

      {:error, reason} ->
        {:error, {:invalid_history, reason}}
    end
  end

  defp tally(result, candidate, event_bytes, deleted) do
    %Result{
      result
      | episodes: result.episodes + 1,
        event_rows: result.event_rows + deleted.event_rows,
        event_bytes: result.event_bytes + event_bytes,
        receipt_rows: result.receipt_rows + deleted.receipt_rows,
        receipt_bytes: result.receipt_bytes + candidate.receipt_bytes,
        lifecycle_intent_rows: result.lifecycle_intent_rows + deleted.lifecycle_intent_rows,
        lifecycle_intent_bytes: result.lifecycle_intent_bytes + candidate.lifecycle_intent_bytes,
        external_operation_rows:
          result.external_operation_rows + elem(deleted.external_operations, 0),
        external_operation_bytes:
          result.external_operation_bytes + elem(deleted.external_operations, 1),
        admission_request_rows:
          result.admission_request_rows + elem(deleted.admission_requests, 0),
        admission_request_bytes:
          result.admission_request_bytes + elem(deleted.admission_requests, 1),
        recording_rows: result.recording_rows + elem(deleted.recordings, 0),
        recording_bytes: result.recording_bytes + elem(deleted.recordings, 1),
        screen_share_lease_rows:
          result.screen_share_lease_rows + elem(deleted.screen_share_leases, 0),
        screen_share_lease_bytes:
          result.screen_share_lease_bytes + elem(deleted.screen_share_leases, 1),
        publication_fence_rows:
          result.publication_fence_rows + elem(deleted.publication_fences, 0),
        publication_fence_bytes:
          result.publication_fence_bytes + elem(deleted.publication_fences, 1),
        publication_grant_reservation_rows:
          result.publication_grant_reservation_rows + elem(deleted.grant_reservations, 0),
        publication_grant_reservation_bytes:
          result.publication_grant_reservation_bytes + elem(deleted.grant_reservations, 1)
    }
  end

  defp candidate([
         tenant_id,
         space_id,
         episode_id,
         config_snapshot,
         deadline_at,
         deadline_generation,
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
      deadline_at: deadline_at,
      deadline_generation: deadline_generation,
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
