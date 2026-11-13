defmodule ChalkSync.Stateholder.Postgres.Recording.Epoch do
  @moduledoc """
  Locks and reads the capture epoch of a recording and validates capture transitions against it.
  """

  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: FinalizerSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: PlannerSQL
  require OperationTable

  def pending_source?(connection, episode, id, name, recording_id) do
    match?(
      %{name: ^name, status: :pending, recording_id: ^recording_id},
      lock_external_operation(connection, episode, id)
    )
  end


  def lock(connection, episode, recording_id) do
    Postgrex.query!(
      connection,
      PlannerSQL.lock_recording(),
      Scope.episode(episode) ++ [Scope.uuid(recording_id)]
    ).rows
  end


  def advance_capture_ready(
         connection,
         episode,
         recording_id,
         capture_epoch,
         start_operation_id,
         start_operation_uuid
       ) do
    with :ok <- validate_start_applied(connection, episode, start_operation_id) do
      params =
        Scope.episode(episode) ++
          [Scope.uuid(recording_id), capture_epoch, start_operation_uuid]

      case Postgrex.query!(connection, PlannerSQL.advance_recording_capture_epoch(), params).rows do
        [[_recording_id]] ->
          {:ok, %{recording_id: recording_id, target: nil, sources: []}}

        [] ->
          {:error, :stale_recording_fence}
      end
    end
  end


  def validate_start_applied(connection, episode, start_operation_id) do
    case lock_external_operation(connection, episode, start_operation_id) do
      %{name: :start_recording, status: :applied} -> :ok
      _ -> {:error, :stale_recording_fence}
    end
  end


  def validate_capture_stopped(
         connection,
         episode,
         %{payload: %{"deadlineAtMs" => deadline_at_ms, "captureEpoch" => epoch}} = operation,
         recording_status,
         _recording_stop_id,
         metadata
       )
       when is_integer(deadline_at_ms) and deadline_at_ms > 0 and is_integer(epoch) and epoch > 0 do
    recording_id = operation.payload["recordingId"]
    params = Scope.episode(episode) ++ [Scope.uuid(recording_id), epoch, deadline_at_ms]

    if recording_status in ["starting", "recording", "stopping", "stopped"] and
         capture_epoch(metadata) <= epoch and
         Postgrex.query!(connection, PlannerSQL.validate_recording_capture_deadline(), params).num_rows ==
           1 do
      {:ok, %{recording_id: recording_id, target: nil, sources: []}}
    else
      {:error, :stale_recording_fence}
    end
  end

  def validate_capture_stopped(
         connection,
         episode,
         operation,
         recording_status,
         recording_stop_id,
         metadata
       ) do
    recording_id = operation.payload["recordingId"]
    stop_operation_id = operation.payload["stopOperationId"]
    capture_epoch = operation.payload["captureEpoch"]
    stop_operation_uuid = Scope.uuid(stop_operation_id)
    source_operation = lock_external_operation(connection, episode, stop_operation_id)

    valid_source =
      case source_operation do
        %{
          name: :stop_recording,
          status: :applied,
          recording_id: ^recording_id
        } ->
          recording_status in ["stopping", "stopped"] and
            recording_stop_id == stop_operation_uuid

        %{name: name, recording_id: ^recording_id}
        when OperationTable.is_episode_end_name(name) ->
          recording_status in ["starting", "recording", "stopping", "stopped"]

        _ ->
          false
      end

    if valid_source and capture_epoch(metadata) <= capture_epoch do
      {:ok, %{recording_id: recording_id, target: nil, sources: []}}
    else
      {:error, :stale_recording_fence}
    end
  end


  def validate_advanced_capture_epoch(
         connection,
         episode,
         recording_id,
         capture_epoch,
         start_operation_id,
         start_operation_uuid
       ) do
    case advance_capture_ready(
           connection,
           episode,
           recording_id,
           capture_epoch,
           start_operation_id,
           start_operation_uuid
         ) do
      {:ok, _prepared} -> :ok
      error -> error
    end
  end


  defp lock_external_operation(connection, episode, external_operation_id) do
    params = Scope.episode(episode) ++ [Scope.uuid(external_operation_id)]

    case Postgrex.query!(connection, FinalizerSQL.lock_operation(), params).rows do
      [row] -> ExternalOperationRecord.from_row(row)
      [] -> nil
    end
  end


  def capture_epoch(metadata) when is_map(metadata) do
    case Map.get(metadata, "capture_epoch") do
      epoch when is_integer(epoch) and epoch >= 0 -> epoch
      epoch when is_binary(epoch) -> parse_capture_epoch(epoch)
      _ -> 0
    end
  end

  def capture_epoch(_metadata), do: 0


  defp parse_capture_epoch(value) do
    case Integer.parse(value) do
      {epoch, ""} when epoch >= 0 -> epoch
      _ -> 0
    end
  end
end
