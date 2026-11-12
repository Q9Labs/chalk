defmodule ChalkSync.Transport.Socket.Outbound do
  @moduledoc """
  The next outbound frame of a v1 socket: live push, recovery completion and the terminal handshake.
  """

  alias ChalkSync.Episodes.Coordinator
  alias ChalkSync.Transport.Socket.Frames
  alias ChalkSync.Transport.Socket.Lifecycle

  @terminal_ack_timeout_ms 5_000

  def pop(%{coordinator: coordinator} = state) do
    case Coordinator.pop(coordinator, self()) do
      {:ok, encoded, :terminal_welcome} ->
        {:stop, :normal, {1000, "participant inactive"},
         {:text, Frames.encode_with_context(state, encoded)},
         %{state | terminal: %{close_code: 1000, reason: :terminal_recovery}}}

      {:ok, encoded, :recovery_complete} ->
        next = state |> Map.put(:phase, :live) |> Lifecycle.start_heartbeat() |> Lifecycle.start_entry_deadline()
        send(self(), :collaboration_drain)
        {:push, {:text, Frames.encode_with_context(next, encoded)}, next}

      {:ok, encoded, false} ->
        {:push, {:text, Frames.encode_with_context(state, encoded)}, Lifecycle.mark_control_checked(state)}

      {:ok, encoded, {:terminal, revision, state_digest}} ->
        Lifecycle.cancel_timer(state.heartbeat_timer)
        timer = Process.send_after(self(), :terminal_ack_timeout, @terminal_ack_timeout_ms)

        {:push, {:text, Frames.encode_with_context(state, encoded)},
         %{
           state
           | phase: :terminal,
             heartbeat_timer: nil,
             terminal_ack_timer: timer,
             terminal_head: %{revision: revision, state_digest: state_digest}
         }}

      :empty ->
        {:ok, state}

      {:error, _reason} ->
        Lifecycle.stop(state, 1012, "delivery recovery required", :delivery_failure)
    end
  end
end
