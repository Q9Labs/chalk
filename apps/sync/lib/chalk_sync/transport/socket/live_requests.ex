defmodule ChalkSync.Transport.Socket.LiveRequests do
  @moduledoc """
  Requests a live v1 client sends to the Episode Coordinator: live targets, directed requests
  and connection quality.
  """

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Transport.Socket.Frames

  def live_target(target, %{phase: :live} = state) do
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

  defp answer({:ok, result}, state),
    do: {:push, {:text, Frames.encode_with_context(state, result)}, state}

  defp answer({:error, reason}, state), do: Frames.protocol_error(reason, state)
end
