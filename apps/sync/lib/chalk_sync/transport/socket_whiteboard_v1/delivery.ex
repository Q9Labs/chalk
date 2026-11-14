defmodule ChalkSync.Transport.SocketWhiteboardV1.Delivery do
  @moduledoc """
  Ordered delivery of Fanout frames to a whiteboard-v1 socket: cursor, replay, gap reset and the outbound queue.
  """

  alias ChalkSync.Transport.SocketWhiteboardV1.Extensions
  alias ChalkSync.Transport.SocketWhiteboardV1.Lifecycle
  alias ChalkSync.Transport.SocketWhiteboardV1.Views
  alias ChalkSync.WhiteboardV1.Episode
  alias ChalkSync.WhiteboardV1.OutboundQueue
  alias ChalkSync.WhiteboardV1.Protocol

  def note_missed_head(%{missed_head: {scene_id, seen}} = state, scene_id, revision)
      when seen >= revision do
    state
  end

  def note_missed_head(state, scene_id, revision) do
    %{state | missed_head: {scene_id, revision}}
  end

  def deliver_in_order(state, frame, scene_id, revision) do
    cond do
      revision <= state.revision -> {:ok, state}
      revision == state.revision + 1 -> deliver_frame(state, frame)
      true -> replay_or_reset(state, state.identity, scene_id, revision)
    end
  end

  def replay_or_reset(%{awaiting_snapshot: true} = state, _identity, _scene_id, _revision) do
    {:ok, state}
  end

  def replay_or_reset(state, identity, scene_id, revision) do
    case Episode.read_after(
           identity,
           scene_id,
           state.revision,
           Extensions.presentation?(state.extensions)
         ) do
      {:ok, frames} ->
        reached = replayed_revision(frames)

        if replay_reaches_head?(state, reached, revision) do
          enqueue_replay(state, scene_id, reached, frames)
        else
          enqueue_gap_reset(state, scene_id)
        end

      _unavailable ->
        enqueue_gap_reset(state, scene_id)
    end
  end

  def enqueue_and_push(state, frames) do
    case enqueue_frames(state.outbound, frames) do
      {:ok, queue} ->
        push_next(%{state | outbound: queue})

      {:error, _reason} ->
        Lifecycle.stop(
          state,
          1012,
          "whiteboard delivery recovery required",
          :delivery_unavailable
        )
    end
  end

  def deliver_frame(state, frame) do
    next = advance_cursor(state, frame)
    enqueue_and_push(next, [frame])
  end

  defp presenter_frame(%{extensions: %Extensions{presentation: :presenter}}, frame), do: frame
  defp presenter_frame(_state, frame), do: Map.delete(frame, "presenter_id")

  def push_next(state) do
    case OutboundQueue.pop(state.outbound, System.monotonic_time(:millisecond)) do
      {:ok, frame, queue} ->
        if queue.frame_count > 0 do
          send(self(), :whiteboard_drain)
        end

        {:push, {:text, Protocol.encode!(presenter_frame(state, frame))},
         %{state | outbound: queue}}

      :empty ->
        {:ok, state}

      {:error, _reason} ->
        Lifecycle.stop(
          state,
          1012,
          "whiteboard delivery recovery required",
          :delivery_unavailable
        )
    end
  end

  def advance_cursor(state, %{"type" => type, "scene_id" => scene_id, "revision" => revision})
      when type in ["update", "commit", "presentation_updated"] do
    %{state | scene_id: scene_id, revision: String.to_integer(revision)}
  end

  def advance_cursor(state, %{
        "type" => "update_part",
        "scene_id" => scene_id,
        "revision" => revision,
        "part" => part,
        "part_count" => part_count
      })
      when part == part_count - 1 do
    %{state | scene_id: scene_id, revision: String.to_integer(revision)}
  end

  def advance_cursor(state, %{
        "type" => "reset_required",
        "scene_id" => scene_id,
        "reason" => "scene_changed"
      }) do
    %{state | scene_id: scene_id, revision: 0}
  end

  def advance_cursor(state, _frame) do
    state
  end

  defp replay_reaches_head?(%{extensions: extensions}, reached, revision) do
    if Extensions.presentation?(extensions), do: reached >= revision, else: reached == revision
  end

  defp replayed_revision([]) do
    0
  end

  defp replayed_revision(frames) do
    frames |> List.last() |> Map.fetch!("revision") |> String.to_integer()
  end

  defp enqueue_gap_reset(state, scene_id) do
    enqueue_and_push(%{state | awaiting_snapshot: true}, [
      %{"type" => "reset_required", "scene_id" => scene_id, "reason" => "gap"}
    ])
  end

  defp enqueue_replay(state, scene_id, revision, frames) do
    case enqueue_frames(state.outbound, frames) do
      {:ok, queue} -> push_next(%{state | outbound: queue, revision: revision})
      {:error, _reason} -> enqueue_gap_reset(state, scene_id)
    end
  end

  def enqueue_frames(queue, frames) do
    now_ms = System.monotonic_time(:millisecond)

    Enum.reduce_while(frames, {:ok, queue}, fn frame, {:ok, current} ->
      case OutboundQueue.push(current, frame, now_ms) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  @doc "A Fanout head notice: replay or reset a live socket, remember it for a recovering one."
  def head(%{phase: :live, identity: identity} = state, scene_id, revision) do
    cond do
      scene_id != state.scene_id ->
        enqueue_and_push(
          %{state | scene_id: scene_id, revision: revision},
          [%{"type" => "reset_required", "scene_id" => scene_id, "reason" => "scene_changed"}]
        )

      revision <= state.revision ->
        {:ok, state}

      true ->
        replay_or_reset(state, identity, scene_id, revision)
    end
  end

  def head(%{phase: :recovering} = state, scene_id, revision) do
    {:ok, note_missed_head(state, scene_id, revision)}
  end

  def head(state, _scene_id, _revision), do: {:ok, state}

  @doc "A Fanout frame for this socket: deliver it in order, hold it while recovering, or drop it."
  def frame(
        %{"type" => "cursor", "participant_id" => id},
        %{identity: %{participant_id: id}} = state
      ),
      do: {:ok, state}

  def frame(
        %{"type" => "view", "participant_id" => id},
        %{identity: %{participant_id: id}, extensions: %Extensions{view: view}} = state
      )
      when view != :owner,
      do: {:ok, state}

  def frame(%{"type" => "view"}, %{extensions: %Extensions{view: :none}} = state),
    do: {:ok, state}

  def frame(
        %{"type" => "presentation_updated"} = frame,
        %{phase: :live, extensions: extensions, scene_id: scene_id} = state
      ) do
    case frame do
      %{"scene_id" => ^scene_id, "revision" => revision} ->
        if Extensions.presentation?(extensions),
          do: deliver_in_order(state, frame, scene_id, String.to_integer(revision)),
          else: {:ok, state}

      _other_scene ->
        {:ok, state}
    end
  end

  def frame(
        %{"type" => type, "scene_id" => scene_id, "revision" => revision} = frame,
        %{phase: :live, scene_id: scene_id} = state
      )
      when type in ["update", "update_part"] and is_binary(revision),
      do: deliver_in_order(state, frame, scene_id, String.to_integer(revision))

  def frame(%{"type" => "view"} = frame, %{phase: :live} = state),
    do: deliver_frame(state, Views.compatible_view(frame, state))

  def frame(frame, %{phase: :live} = state), do: deliver_frame(state, frame)

  def frame(%{"type" => "view"} = frame, %{phase: :recovering} = state) do
    bring = if frame["bring"], do: frame, else: state.pending_bring

    {:ok,
     %{
       state
       | pending_bring: bring,
         pending_views:
           Map.put(state.pending_views, frame["participant_id"], %{frame | "bring" => false})
     }}
  end

  def frame(%{"scene_id" => scene_id, "revision" => revision}, %{phase: :recovering} = state)
      when is_binary(revision),
      do: {:ok, note_missed_head(state, scene_id, String.to_integer(revision))}

  def frame(_frame, state), do: {:ok, state}
end
