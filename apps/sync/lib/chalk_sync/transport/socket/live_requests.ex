defmodule ChalkSync.Transport.Socket.LiveRequests do
  @moduledoc """
  Requests a live v1 client sends to the Episode Coordinator: live targets, directed requests
  and connection quality.
  """

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Observability
  alias ChalkSync.Transport.Socket.Frames

  @target_sources %{
    "set_microphone_enabled" => "microphone",
    "set_camera_enabled" => "camera",
    "set_screen_share_enabled" => "screen"
  }

  def live_target(target, %{phase: :live} = state) do
    state = stamp_intent(state, target)
    answer(Coordinator.live_target(state.coordinator, state.identity, target, self()), state)
  end

  def live_target(_target, state), do: Frames.protocol_error(:recovery_required, state)

  def directed_request(request, %{phase: :live} = state) do
    answer(
      Coordinator.directed_request(state.coordinator, state.identity, request, self()),
      state
    )
  end

  def directed_request(_request, state), do: Frames.protocol_error(:recovery_required, state)

  def connection_quality(quality, %{phase: :live, connection_quality: true} = state) do
    case Coordinator.set_connection_quality(state.coordinator, state.identity, quality, self()) do
      :ok -> {:ok, state}
      {:error, reason} -> Frames.protocol_error(reason, state)
    end
  end

  def connection_quality(_quality, %{phase: :live} = state),
    do: Frames.protocol_error(:connection_quality_not_negotiated, state)

  def connection_quality(_quality, state), do: Frames.protocol_error(:recovery_required, state)

  # Stamps when Sync took a live target, on Sync's own clock and in the socket's trace. The client's
  # `media_intent` carries the same `operation_id`, which joins it to the SFU's `sfu.publication.held`
  # by participant and source. A retry sends the same `operation_id` again; the earliest stamp is the one to read.
  defp stamp_intent(state, target) do
    observability =
      Observability.phase(state.observability, "sync.media.intent", %{
        operation_id: target.operation_id,
        participant_id: state.identity.participant_id,
        source: Map.get(@target_sources, to_string(target.name), "unknown"),
        enabled: target.enabled,
        at_ms: System.system_time(:millisecond)
      })

    %{state | observability: observability}
  end

  defp answer({:ok, result}, state),
    do: {:push, {:text, Frames.encode_with_context(state, result)}, state}

  defp answer({:error, reason}, state), do: Frames.protocol_error(reason, state)
end
