defmodule ChalkSync.Transport.Socket.Annotation do
  @moduledoc "Per-socket annotation projection, ordered independently from Sync control."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.Observability
  alias ChalkSync.ScreenAnnotation.{Attachment, Layer, Presence, Repository}
  alias ChalkSync.Transport.Socket.Frames

  @limits Schema.limits()
  @poll_ms 1_000

  def enter(%{screen_annotation: true, identity: identity} = state) do
    :ok = Presence.join(identity.episode, identity.participant_id)
    Process.send_after(self(), :annotation_tick, @poll_ms)
    state
  end

  def enter(state), do: state

  def initial_snapshot(state), do: refresh(state, true)

  def handle(frame, %{phase: :live, screen_annotation: true} = state) do
    case frame["type"] do
      "annotation_state_request" -> request_state(state)
      "annotation_command" -> command(frame, state)
      "annotation_presence" -> update_presence(frame, state)
    end
  end

  def handle(_frame, state), do: Frames.protocol_error(:annotation_not_negotiated, state)

  def tick(state, refresh_snapshot? \\ false)

  def tick(%{phase: :live, screen_annotation: true} = state, refresh_snapshot?) do
    Process.send_after(self(), :annotation_tick, @poll_ms)
    now = System.monotonic_time(:millisecond)

    case Map.get(state, :annotation_snapshot_request) do
      {due, true} when now >= due -> send_requested_snapshot(state, now)
      _ -> refresh(state, refresh_snapshot?)
    end
  end

  def tick(state, _refresh_snapshot?), do: {:ok, state}

  def changed(%{phase: :live, screen_annotation: true} = state), do: refresh(state, false)
  def changed(state), do: {:ok, state}

  def drain_presence(%{phase: :live, screen_annotation: true} = state) do
    now = System.system_time(:millisecond)

    frames =
      Enum.filter(Presence.take(), fn frame ->
        matching?(state.annotation, frame, now) and
          (frame["expires_at_ms"] > now or (is_nil(frame["cursor"]) and is_nil(frame["draft"])))
      end)

    push(state, frames)
  end

  def drain_presence(state), do: {:ok, state}

  defp request_state(state) do
    now = System.monotonic_time(:millisecond)

    case Map.get(state, :annotation_snapshot_request) do
      {due, _pending} when now < due ->
        {:ok, Map.put(state, :annotation_snapshot_request, {due, true})}

      _ ->
        send_requested_snapshot(state, now)
    end
  end

  defp send_requested_snapshot(state, now) do
    # The next poll serves one waiting replica if more requests arrive during this interval.
    state = Map.put(state, :annotation_snapshot_request, {now + @poll_ms, false})
    refresh(state, true)
  end

  defp command(frame, state) do
    now = System.monotonic_time(:millisecond)
    recent = Enum.filter(state.annotation_commands, &(now - &1 < 1_000))

    result =
      cond do
        length(recent) >= 24 ->
          {:error, "rate_limited"}

        get_in(frame, ["command", "burned_in"]) == true and
            not Map.get(state, :screen_annotation_burn_in, false) ->
          {:error, "forbidden"}

        true ->
          Repository.command(
            state.identity,
            frame,
            state.observability,
            Map.get(state, :attachment)
          )
      end

    response = receipt(result)

    :telemetry.execute([:chalk, :sync, :annotation, :command], %{count: 1}, %{
      outcome: response["kind"]
    })

    receipt = %{
      "type" => "annotation_receipt",
      "operation_id" => frame["operation_id"],
      "result" => response
    }

    timestamps = if length(recent) < 24, do: [now | recent], else: recent
    push(%{state | annotation_commands: timestamps}, [receipt])
  end

  defp receipt({:ok, result}), do: result

  defp receipt({:error, reason}) when is_binary(reason),
    do: %{"kind" => "rejected", "reason" => reason}

  defp receipt(_failure), do: %{"kind" => "rejected", "reason" => "invalid_state"}

  defp update_presence(frame, state) do
    now = System.system_time(:millisecond)

    if matching?(state.annotation, frame, now) and state.annotation.can_draw do
      sample =
        Map.merge(frame, %{
          "author" => state.annotation.author,
          "server_at_ms" => now,
          "expires_at_ms" => now + @limits["ephemeralTtlMs"]
        })

      Presence.publish(sample)
    end

    {:ok, state}
  end

  defp matching?(
         %{layer: layer, fence: fence, until: until},
         %{"layer_id" => layer, "fence" => fence},
         now
       ),
       do: now < until

  defp matching?(_witness, _frame, _now), do: false

  defp refresh(state, forced?) do
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

  defp project(state, forced?, _actor, %{binding: %{"burned_in" => true}}, now, _share, epoch)
       when not is_map_key(state, :screen_annotation_burn_in) or
              state.screen_annotation_burn_in == false do
    # An older viewer can play the video but must not be offered a second copy of the ink.
    suspend(state, forced?, now, epoch)
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
    do: min(attachment.expires_at_ms, now + 2 * @poll_ms)

  defp witness_deadline(_state, now), do: now + 2 * @poll_ms

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

  defp snapshot(state, now),
    do: %{"type" => "annotation_state", "state" => state, "server_at_ms" => now}

  defp push(state, []), do: {:ok, state}

  defp push(state, frames) do
    context = Observability.frame_fields(state.observability)
    {:push, Enum.map(frames, &{:text, JSON.encode!(Map.merge(&1, context))}), state}
  end
end
