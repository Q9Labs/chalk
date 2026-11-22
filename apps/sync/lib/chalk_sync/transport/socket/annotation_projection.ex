defmodule ChalkSync.Transport.Socket.AnnotationProjection do
  @moduledoc "Reads a committed annotation witness and projects it onto a socket."

  alias ChalkSync.Observability
  alias ChalkSync.ScreenAnnotation.{Attachment, Layer, Presence, Repository}

  @witness_ms 2_000

  def refresh(state, forced?) do
    epoch = Presence.begin_refresh(state.identity)

    case Repository.read(state.identity) do
      {:ok, actor, layer, now, share} ->
        if not Map.has_key?(state, :attachment) or
             Attachment.matches?(layer, state.attachment, now) do
          project(state, forced?, actor, layer, now, share, epoch)
        else
          end_attachment(state, epoch)
        end

      _failure when is_map_key(state, :attachment) ->
        end_attachment(state, epoch)

      {:error, "not_active"} ->
        close_layer(state, forced?, System.system_time(:millisecond), nil, epoch, :lost_seat)

      _failure ->
        suspend(state, forced?, System.system_time(:millisecond), epoch)
    end
  end

  defp end_attachment(state, epoch) do
    _ = Presence.confirm(epoch, nil)
    {:stop, :normal, {1008, "annotation attachment ended"}, state}
  end

  defp project(state, forced?, _actor, nil, now, share, epoch) do
    close_layer(state, forced?, now, share, epoch, :lost_publication)
  end

  defp project(state, forced?, actor, layer, now, share, epoch) do
    id = layer.binding["layer_id"]
    access = Layer.access(layer, actor)

    witness = %{
      layer: id,
      publication: share.publication,
      fence: layer.fence,
      revision: layer.revision,
      until: min(share.until, witness_deadline(state, now)),
      author: actor.author,
      can_draw: access["can_draw"]
    }

    case Presence.confirm(epoch, witness) do
      :ok ->
        frames = projection_frames(state.annotation, witness, layer, actor, now, forced?)
        push(%{state | annotation: witness}, frames)

      :stale ->
        suspend(state, forced?, now, epoch)
    end
  end

  defp close_layer(state, forced?, now, share, epoch, cause) do
    _ = Presence.confirm(epoch, nil)

    closing =
      case state.annotation do
        %{layer: id, publication: publication} ->
          reason = retirement_reason(state.identity, share, publication, cause)
          [%{"type" => "annotation_closed", "layer_id" => id, "reason" => reason}]

        _ ->
          []
      end

    frames = if forced?, do: closing ++ [snapshot(nil, now)], else: closing
    push(%{state | annotation: nil}, frames)
  end

  defp retirement_reason(identity, _share, _publication, :lost_seat),
    do: Repository.closed_reason(identity)

  defp retirement_reason(_identity, %{publication: observed}, publication, _cause)
       when observed != publication,
       do: "share_replaced"

  defp retirement_reason(_identity, _share, _publication, _cause), do: "share_ended"

  # A read that raced an invalidation is not evidence that the layer closed.
  # Withdraw the projection until the next committed witness instead.
  defp suspend(state, forced?, now, epoch) do
    _ = Presence.confirm(epoch, nil)
    frames = if forced? or state.annotation, do: [snapshot(nil, now)], else: []
    push(%{state | annotation: nil}, frames)
  end

  defp witness_deadline(%{attachment: attachment}, now),
    do: min(attachment.expires_at_ms, now + @witness_ms)

  defp witness_deadline(_state, now), do: now + @witness_ms

  defp projection_frames(previous, witness, layer, actor, now, forced?) do
    case previous do
      %{layer: old} when old != witness.layer ->
        [
          %{"type" => "annotation_closed", "layer_id" => old, "reason" => "share_replaced"},
          snapshot(Layer.snapshot(layer, actor), now)
        ]

      %{revision: revision} when revision == witness.revision and not forced? ->
        []

      %{revision: revision}
      when revision + 1 == witness.revision and not forced? and is_map(layer.last_change) ->
        change =
          if layer.last_change["kind"] == "control",
            do: Map.put(layer.last_change, "access", Layer.access(layer, actor)),
            else: layer.last_change

        [
          %{
            "type" => "annotation_changed",
            "layer_id" => witness.layer,
            "revision" => witness.revision,
            "fence" => witness.fence,
            "server_at_ms" => now,
            "change" => change
          }
        ]

      _ ->
        [snapshot(Layer.snapshot(layer, actor), now)]
    end
  end

  def snapshot(state, now),
    do: %{"type" => "annotation_state", "state" => state, "server_at_ms" => now}

  def push(state, []), do: {:ok, state}

  def push(state, frames) do
    context = Observability.frame_fields(state.observability)
    {:push, Enum.map(frames, &{:text, JSON.encode!(Map.merge(&1, context))}), state}
  end
end
