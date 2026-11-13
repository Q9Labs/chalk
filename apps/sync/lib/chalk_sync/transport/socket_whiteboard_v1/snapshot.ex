defmodule ChalkSync.Transport.SocketWhiteboardV1.Snapshot do
  @moduledoc """
  Snapshot recovery of a whiteboard-v1 socket: resume what arrived while it waited.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Access
  alias ChalkSync.Transport.SocketWhiteboardV1.Delivery
  alias ChalkSync.Transport.SocketWhiteboardV1.Failure
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.Transport.SocketWhiteboardV1.Views
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.Protocol

  @max_pending_snapshots ChalkSync.Contract.GeneratedWhiteboardV1.limits()[
                           "pendingOperationMaxItems"
                         ]

  defp resume_pending_bring(state) do
    frames =
      if state.pending_bring, do: [Views.compatible_view(state.pending_bring, state)], else: []

    with {:ok, outbound} <- Delivery.enqueue_frames(state.outbound, frames) do
      if frames != [], do: send(self(), :whiteboard_drain)

      Enum.each(state.pending_views, fn {_person, frame} ->
        send(self(), {:whiteboard_v1_frame, frame})
      end)

      {:ok, %{state | outbound: outbound, pending_bring: nil, pending_views: %{}}}
    end
  end

  def resume_after_snapshot(state, missed_head) do
    case resume_pending_bring(state) do
      {:ok, resumed} ->
        resumed = Access.resume_stale_access(resumed)
        resume_snapshot_requests(resumed)
        catch_up_after_snapshot(resumed, missed_head)

      {:error, _reason} ->
        Lifecycle.stop(
          state,
          1012,
          "whiteboard delivery recovery required",
          :delivery_unavailable
        )
    end
  end

  defp catch_up_after_snapshot(state, nil) do
    {:ok, state}
  end

  defp catch_up_after_snapshot(state, {scene_id, revision}) do
    Delivery.head(state, scene_id, revision)
  end

  def resume_snapshot_requests(%{pending_snapshot_requests: []}) do
    :ok
  end

  def resume_snapshot_requests(_state) do
    send(self(), :whiteboard_snapshot_next)
  end

  @doc "A snapshot request: queue it while recovering, otherwise start the page stream."
  def request(request, %{phase: :recovering, snapshot: snapshot} = state) do
    pending = state.pending_snapshot_requests

    cond do
      request.request_id == snapshot.request_id or request in pending ->
        {:ok, state}

      length(pending) < @max_pending_snapshots ->
        {:ok, %{state | pending_snapshot_requests: pending ++ [request]}}

      true ->
        Failure.operation_failure(
          request.request_id,
          :request_snapshot,
          {:retryable, :overloaded},
          state
        )
    end
  end

  def request(%{request_id: request_id}, %{phase: :live, identity: identity} = state) do
    state = %{
      state
      | pending_snapshot_requests:
          Enum.reject(state.pending_snapshot_requests, &(&1.request_id == request_id))
    }

    case Episode.snapshot(identity, request_id) do
      {:ok, [first | remaining]} ->
        snapshot = %{
          request_id: request_id,
          scene_id: first["scene_id"],
          revision: first["revision"],
          acknowledged_page: -1,
          remaining: remaining
        }

        next =
          %{state | phase: :recovering, snapshot: snapshot, awaiting_snapshot: false}
          |> Lifecycle.observe_operation("request_snapshot", "accepted")

        {:push, {:text, Protocol.encode!(first)}, next}

      failure ->
        Failure.operation_failure(
          request_id,
          :request_snapshot,
          failure,
          %{state | awaiting_snapshot: false}
        )
    end
  end

  @doc "The client confirmed one snapshot page: send the next, or go live again."
  def acknowledge(acknowledgement, %{phase: :recovering, snapshot: snapshot} = state) do
    expected_page = snapshot.acknowledged_page + 1

    if matches?(acknowledgement, snapshot, expected_page) do
      advance(snapshot, expected_page, state)
    else
      Lifecycle.stop(state, 1008, "invalid snapshot acknowledgement", :invalid_acknowledgement)
    end
  end

  @doc "Start the next queued request once the outbound queue is empty."
  def next_request(%{pending_snapshot_requests: []} = state), do: {:ok, state}

  def next_request(%{pending_snapshot_requests: [queued | remaining]} = state) do
    result = request(queued, %{state | pending_snapshot_requests: remaining})

    case result do
      {:push, _frame, %{phase: :live} = next} -> resume_snapshot_requests(next)
      _recovering -> :ok
    end

    result
  end

  defp matches?(acknowledgement, snapshot, expected_page) do
    acknowledgement.request_id == snapshot.request_id and
      acknowledgement.scene_id == snapshot.scene_id and
      acknowledgement.revision == snapshot.revision and acknowledgement.page == expected_page
  end

  defp advance(%{remaining: [next | remaining]} = snapshot, page, state) do
    next_snapshot = %{snapshot | acknowledged_page: page, remaining: remaining}
    {:push, {:text, Protocol.encode!(next)}, %{state | snapshot: next_snapshot}}
  end

  defp advance(%{remaining: []} = snapshot, _page, state) do
    live = %{
      state
      | phase: :live,
        snapshot: nil,
        scene_id: snapshot.scene_id,
        revision: String.to_integer(snapshot.revision),
        missed_head: nil
    }

    resume_after_snapshot(live, state.missed_head)
  end
end
