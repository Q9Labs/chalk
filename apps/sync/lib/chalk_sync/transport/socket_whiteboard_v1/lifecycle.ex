defmodule ChalkSync.Transport.SocketWhiteboardV1.Lifecycle do
  @moduledoc """
  Close and observability steps of a whiteboard-v1 socket.
  """

  alias ChalkSync.Observability
  alias ChalkSync.Transport.SocketClose

  def stop(state, close_code, message, reason) do
    terminal = %{close_code: close_code, reason: reason}
    {:stop, :normal, {close_code, message}, %{state | terminal: terminal}}
  end

  # The close trace keeps a bounded failure category; the peer sees only that it may retry.
  def dependency_unavailable(state, failure) do
    {:stop, reason, close, state} =
      stop(state, 1012, "dependency unavailable", :dependency_unavailable)

    {:stop, reason, close, put_in(state.terminal[:failure], failure)}
  end

  def observe_operation(state, operation, outcome) do
    observability =
      Observability.phase(state.observability, "sync.whiteboard", %{
        operation: to_string(operation),
        outcome: outcome
      })

    %{state | observability: observability}
  end

  def observe_terminal(state, terminate_reason) do
    now = System.monotonic_time(:millisecond)

    Observability.terminal(
      state.observability,
      "sync.websocket.closed",
      state.connection_attributes
      |> Map.merge(SocketClose.attributes(terminate_reason, state.terminal))
      |> Map.merge(%{
        protocol: "whiteboard-v1",
        phase: state.phase,
        socket_age_ms: now - state.opened_at_ms,
        heartbeat_gap_ms: if(state.last_heartbeat_at_ms, do: now - state.last_heartbeat_at_ms)
      })
      |> put_scene_id(state.scene_id)
    )
  end

  def merge_hello_observability(state, nil), do: state

  def merge_hello_observability(state, baggage) do
    observability =
      Observability.merge(
        state.observability,
        Observability.context(%{"baggage" => baggage})
      )

    Observability.bind_logger(observability)
    %{state | observability: observability}
  end

  def cancel_timer(nil), do: :ok
  def cancel_timer(timer), do: Process.cancel_timer(timer)

  defp put_scene_id(attributes, scene_id) when is_binary(scene_id) do
    Map.put(attributes, :scene_id, scene_id)
  end

  defp put_scene_id(attributes, _scene_id), do: attributes
end
