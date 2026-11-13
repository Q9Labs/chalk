defmodule ChalkSync.Stateholder.Postgres.Recording do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Recording.Epoch
  alias ChalkSync.Stateholder.Postgres.Scope

  def prepare_capture_ready(connection, episode, operation) do
    recording_id = operation.payload["recordingId"]
    start_operation_id = operation.payload["startOperationId"]
    capture_epoch = operation.payload["captureEpoch"]
    start_operation_uuid = Scope.uuid(start_operation_id)

    case Epoch.lock(connection, episode, recording_id) do
      [["starting", _generation, _metadata, start_id, nil]]
      when start_id == start_operation_uuid ->
        Epoch.advance_capture_ready(
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

    case Epoch.lock(connection, episode, recording_id) do
      [[recording_status, _generation, metadata, _start_id, stop_id]] ->
        Epoch.validate_capture_stopped(
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

    case Epoch.lock(connection, episode, recording_id) do
      [[status, _generation, _metadata, start_id, _stop_id]]
      when status in ["starting", "recording", "stopping"] and
             start_id == start_operation_uuid ->
        with :ok <- Epoch.validate_start_applied(connection, episode, start_operation_id) do
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

    case Epoch.lock(connection, episode, recording_id) do
      [["starting", _generation, metadata, start_id, nil]]
      when start_id == start_operation_uuid ->
        current_epoch = Epoch.capture_epoch(metadata)

        cond do
          current_epoch == capture_epoch ->
            Epoch.validate_start_applied(connection, episode, start_operation_id)

          is_integer(capture_epoch) and capture_epoch > current_epoch ->
            Epoch.validate_advanced_capture_epoch(
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

    case Epoch.lock(connection, episode, recording_id) do
      [[recording_status, _generation, metadata, _start_id, stop_id]] ->
        case Epoch.validate_capture_stopped(
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

    case Epoch.lock(connection, episode, recording_id) do
      [[status, _generation, _metadata, start_id, _stop_id]]
      when status in ["starting", "recording", "stopping"] and
             start_id == start_operation_uuid ->
        Epoch.validate_start_applied(connection, episode, start_operation_id)

      _ ->
        {:error, :stale_recording_fence}
    end
  end

  def validate_capture_epoch(_connection, _episode, _external), do: :ok

  def capture_source_pending?(connection, episode, %{name: name, payload: payload})
      when name in [:recording_capture_ready, :recording_capture_failed] do
    recording_id = payload["recordingId"]
    start_id = payload["startOperationId"]
    start_uuid = Scope.uuid(start_id)

    case Epoch.lock(connection, episode, recording_id) do
      [[status, _generation, metadata, ^start_uuid, stop_id]] ->
        valid_recording =
          if name == :recording_capture_ready do
            status == "starting" and is_nil(stop_id) and
              is_integer(payload["captureEpoch"]) and
              payload["captureEpoch"] >= Epoch.capture_epoch(metadata)
          else
            status in ["starting", "recording", "stopping"]
          end

        valid_recording and
          Epoch.pending_source?(connection, episode, start_id, :start_recording, recording_id)

      _ ->
        false
    end
  end

  def capture_source_pending?(connection, episode, %{
        name: :recording_capture_stopped,
        payload: payload
      }) do
    recording_id = payload["recordingId"]
    stop_id = payload["stopOperationId"]

    if is_binary(stop_id) do
      stop_uuid = Scope.uuid(stop_id)

      case Epoch.lock(connection, episode, recording_id) do
        [[status, _generation, metadata, _start_id, ^stop_uuid]]
        when status in ["stopping", "stopped"] ->
          is_integer(payload["captureEpoch"]) and
            payload["captureEpoch"] >= Epoch.capture_epoch(metadata) and
            Epoch.pending_source?(connection, episode, stop_id, :stop_recording, recording_id)

        _ ->
          false
      end
    else
      false
    end
  end

  def capture_source_pending?(_connection, _episode, _external), do: false

  def stopped?(connection, episode, recording_id) do
    match?(
      [["stopped", _generation, _metadata, _start_id, _stop_id]],
      Epoch.lock(connection, episode, recording_id)
    )
  end
end
