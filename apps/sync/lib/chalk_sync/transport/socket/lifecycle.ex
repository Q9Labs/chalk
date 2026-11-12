defmodule ChalkSync.Transport.Socket.Lifecycle do
  @moduledoc """
  Timers and close steps of a v1 socket.
  """

  alias ChalkSync.Observability
  alias ChalkSync.Transport.CollaborationQueue, as: CollaborationQueue

  @entry_timeout_ms 120_000
  @heartbeat_interval_ms 20_000

  def heartbeat_attributes(state) do
    now = System.monotonic_time(:millisecond)

    %{
      socket_age_ms: now - state.opened_at_ms,
      heartbeat_gap_ms: if(state.last_heartbeat_at_ms, do: now - state.last_heartbeat_at_ms)
    }
  end


  def stop(state, close_code, message, reason) do
    {:stop, :normal, {close_code, message},
     %{state | terminal: %{close_code: close_code, reason: reason}}}
  end


  def merge_hello_observability(state, correlation) when is_map(correlation) do
    observability =
      Observability.merge(state.observability, Observability.context(correlation))

    Observability.bind_logger(observability)
    %{state | observability: observability}
  end

  def merge_hello_observability(state, _correlation), do: state


  def start_entry_deadline(%{entry_confirmation: true} = state) do
    %{state | entry_timer: Process.send_after(self(), :entry_timeout, @entry_timeout_ms)}
  end

  def start_entry_deadline(state), do: state


  def start_heartbeat(state) do
    state
    |> Map.put(:missed_heartbeats, 0)
    |> schedule_heartbeat()
  end


  def schedule_heartbeat(state) do
    cancel_timer(state.heartbeat_timer)
    timer = Process.send_after(self(), :heartbeat_check, @heartbeat_interval_ms)
    %{state | heartbeat_timer: timer}
  end


  def cancel_timer(timer) when is_reference(timer), do: Process.cancel_timer(timer)
  def cancel_timer(_timer), do: false


  def mark_control_checked(state) do
    _result = CollaborationQueue.control_checked(state.collaboration_queue)
    state
  end
end
