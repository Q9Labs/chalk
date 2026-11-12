defmodule ChalkSync.Transport.SocketWhiteboardV1.Access do
  @moduledoc """
  Drawing permission of a whiteboard-v1 socket: read the server answer, repair missed notifications with a timer.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1.Delivery
  alias ChalkSync.WhiteboardV1.Episode

  @access_reconcile_ms 30_000
  @access_retry_ms 1_000

  def resume_stale_access(%{access_stale: false} = state), do: state

  def resume_stale_access(state) do
    send(self(), :whiteboard_v1_access_changed)
    %{state | access_stale: false}
  end

  # The server computes each person's drawing permission; a socket only
  # relays its own. Clients without draw_policy_v1 keep the legacy frame.
  # Notifications only speed this up: one timer per socket reads the answer
  # again, so a missed notification is repaired and an outage costs one retry.
  def refresh_access(%{identity: identity} = state) do
    case Episode.draw_access(identity) do
      {:ok, access} ->
        state
        |> arm_access_timer(@access_reconcile_ms)
        |> Map.merge(%{can_draw: access["can_draw"], access: access})
        |> Delivery.enqueue_and_push(access_frames(state, access))

      {:error, :permission_denied} ->
        {:ok, state}

      _unavailable ->
        {:ok, arm_access_timer(state, @access_retry_ms)}
    end
  end

  defp arm_access_timer(%{access_timer: timer} = state, delay) do
    if timer, do: Process.cancel_timer(timer)
    %{state | access_timer: Process.send_after(self(), :whiteboard_v1_access_changed, delay)}
  end

  defp access_frames(%{extensions: %Extensions{draw_policy: true}, access: access}, access),
    do: []

  defp access_frames(%{extensions: %Extensions{draw_policy: true}}, access), do: [access]
  defp access_frames(%{can_draw: can_draw}, %{"can_draw" => can_draw}), do: []

  defp access_frames(%{identity: identity}, access) do
    [
      %{
        "type" => "permission_updated",
        "participant_id" => identity.participant_id,
        "can_draw" => access["can_draw"]
      }
    ]
  end
end
