defmodule ChalkSync.Retention.CleanupWorker.Deletion do
  @moduledoc """
  Deletes an Episode's collaboration data and writes its retention checkpoint.
  """

  alias ChalkSync.Retention.SQL

  def delete_episode(transaction, candidate, event_count) do
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

    delete_measurement(transaction, SQL.delete_media_pauses(), candidate)
    delete_measurement(transaction, SQL.delete_media_stops(), candidate)

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

    %{
      receipt_rows: receipt_rows,
      lifecycle_intent_rows: lifecycle_intent_rows,
      event_rows: event_rows,
      external_operations: external_operations,
      admission_requests: admission_requests,
      recordings: recordings,
      screen_share_leases: screen_share_leases,
      publication_fences: publication_fences,
      grant_reservations: grant_reservations
    }
  end

  def write_checkpoint(transaction, candidate, now, event_count, event_bytes, measurements) do
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

  def delete_count(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, [candidate.tenant_id, candidate.episode_id]).rows do
      [[count]] -> count
    end
  end

  def delete_measurement(transaction, query, candidate) do
    measurement(transaction, query, candidate)
  end

  def measurement(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, [candidate.tenant_id, candidate.episode_id]).rows do
      [[rows, bytes]] -> {rows, bytes}
    end
  end

  def clear_terminal_operation_event_links(transaction, candidate) do
    Postgrex.query!(transaction, SQL.clear_terminal_operation_event_links(), [
      candidate.tenant_id,
      candidate.episode_id
    ])
  end

  def delete_collaboration_data(transaction, candidate) do
    Postgrex.query!(transaction, SQL.lock_chat_stream(), space_scope(candidate))

    _measurement =
      delete_measurement(transaction, SQL.delete_chat_read_receipts(), candidate)

    _measurement = delete_measurement(transaction, SQL.delete_chat_messages(), candidate)

    Postgrex.query!(transaction, SQL.reconcile_chat_stream(), space_scope(candidate))

    _measurement =
      delete_space_measurement(transaction, SQL.delete_chat_streams(), candidate)

    collaboration_deletions = [
      SQL.delete_whiteboard_operation_receipts(),
      SQL.delete_whiteboard_permissions(),
      SQL.delete_whiteboard_draw_policies(),
      SQL.delete_whiteboard_draw_policy_receipts(),
      SQL.delete_whiteboard_elements(),
      SQL.delete_whiteboard_scenes()
    ]

    Enum.each(collaboration_deletions, fn query ->
      _measurement = delete_measurement(transaction, query, candidate)
    end)
  end

  defp delete_space_measurement(transaction, query, candidate) do
    case Postgrex.query!(transaction, query, space_scope(candidate)).rows do
      [[rows, bytes]] -> {rows, bytes}
    end
  end

  defp space_scope(candidate), do: [candidate.tenant_id, candidate.space_id]
end
