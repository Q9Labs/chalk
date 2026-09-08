defmodule ChalkSync.Stateholder.Postgres.Recording do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: FinalizerSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: PlannerSQL

  def prepare_capture_ready(connection, episode, operation) do
    recording_id = operation.payload["recordingId"]
    start_operation_id = operation.payload["startOperationId"]
    capture_epoch = operation.payload["captureEpoch"]
    start_operation_uuid = Scope.uuid(start_operation_id)

    case lock(connection, episode, recording_id) do
      [["starting", _generation, _metadata, start_id, nil]]
      when start_id == start_operation_uuid ->
        advance_capture_ready(
          connection,
          episode,
          recording_id,
          capture_epoch,
          start_operation_id,
          start_operation_uuid
        )

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def prepare_capture_stopped(connection, episode, operation) do
    recording_id = operation.payload["recordingId"]

    case lock(connection, episode, recording_id) do
      [[recording_status, _generation, metadata, _start_id, stop_id]] ->
        validate_capture_stopped(
          connection,
          episode,
          operation,
          recording_status,
          stop_id,
          metadata
        )

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def prepare_capture_failed(connection, episode, operation) do
    recording_id = operation.payload["recordingId"]
    start_operation_id = operation.payload["startOperationId"]
    start_operation_uuid = Scope.uuid(start_operation_id)

    case lock(connection, episode, recording_id) do
      [[status, _generation, _metadata, start_id, _stop_id]]
      when status in ["starting", "recording", "stopping"] and
             start_id == start_operation_uuid ->
        with :ok <- validate_start_applied(connection, episode, start_operation_id) do
          {:ok, %{recording_id: recording_id, target: nil, sources: []}}
        end

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def validate_capture_epoch(
        connection,
        episode,
        %{name: :recording_capture_ready} = external
      ) do
    recording_id = external.payload["recordingId"]
    start_operation_id = external.payload["startOperationId"]
    capture_epoch = external.payload["captureEpoch"]
    start_operation_uuid = Scope.uuid(start_operation_id)

    case lock(connection, episode, recording_id) do
      [["starting", _generation, metadata, start_id, nil]]
      when start_id == start_operation_uuid ->
        current_epoch = capture_epoch(metadata)

        cond do
          current_epoch == capture_epoch ->
            validate_start_applied(connection, episode, start_operation_id)

          is_integer(capture_epoch) and capture_epoch > current_epoch ->
            validate_advanced_capture_epoch(
              connection,
              episode,
              recording_id,
              capture_epoch,
              start_operation_id,
              start_operation_uuid
            )

          true ->
            {:error, :stale_recording_fence}
        end

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def validate_capture_epoch(
        connection,
        episode,
        %{name: :recording_capture_stopped} = external
      ) do
    recording_id = external.payload["recordingId"]

    case lock(connection, episode, recording_id) do
      [[recording_status, _generation, metadata, _start_id, stop_id]] ->
        case validate_capture_stopped(
               connection,
               episode,
               external,
               recording_status,
               stop_id,
               metadata
             ) do
          {:ok, _prepared} -> :ok
          error -> error
        end

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def validate_capture_epoch(
        connection,
        episode,
        %{name: :recording_capture_failed} = external
      ) do
    recording_id = external.payload["recordingId"]
    start_operation_id = external.payload["startOperationId"]
    start_operation_uuid = Scope.uuid(start_operation_id)

    case lock(connection, episode, recording_id) do
      [[status, _generation, _metadata, start_id, _stop_id]]
      when status in ["starting", "recording", "stopping"] and
             start_id == start_operation_uuid ->
        validate_start_applied(connection, episode, start_operation_id)

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def validate_capture_epoch(_connection, _episode, _external), do: :ok

  def stopped?(connection, episode, recording_id) do
    match?(
      [["stopped", _generation, _metadata, _start_id, _stop_id]],
      lock(connection, episode, recording_id)
    )
  end

  defp lock(connection, episode, recording_id) do
    Postgrex.query!(
      connection,
      PlannerSQL.lock_recording(),
      Scope.episode(episode) ++ [Scope.uuid(recording_id)]
    ).rows
  end

  defp advance_capture_ready(
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

  defp validate_start_applied(connection, episode, start_operation_id) do
    case lock_external_operation(connection, episode, start_operation_id) do
      %{name: :start_recording, status: :applied} -> :ok
      _ -> {:error, :stale_recording_fence}
    end
  end

  defp validate_capture_stopped(
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
        when name in [:end_episode, :tenant_end_episode, :maximum_duration_expired] ->
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

  defp validate_advanced_capture_epoch(
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

  defp capture_epoch(metadata) when is_map(metadata) do
    case Map.get(metadata, "capture_epoch") do
      epoch when is_integer(epoch) and epoch >= 0 -> epoch
      epoch when is_binary(epoch) -> parse_capture_epoch(epoch)
      _ -> 0
    end
  end

  defp capture_epoch(_metadata), do: 0

  defp parse_capture_epoch(value) do
    case Integer.parse(value) do
      {epoch, ""} when epoch >= 0 -> epoch
      _ -> 0
    end
  end
end
