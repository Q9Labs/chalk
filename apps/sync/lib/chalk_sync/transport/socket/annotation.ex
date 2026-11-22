defmodule ChalkSync.Transport.Socket.Annotation do
  @moduledoc "Per-socket annotation projection, ordered independently from Sync control."

  alias ChalkSync.Contract.GeneratedScreenAnnotationV1, as: Schema
  alias ChalkSync.ScreenAnnotation.{Availability, Presence, Repository}
  alias ChalkSync.Transport.Socket.AnnotationProjection, as: Projection
  alias ChalkSync.Transport.Socket.Frames

  @limits Schema.limits()
  @poll_ms 1_000

  def enter(%{screen_annotation: true, identity: identity} = state) do
    if Availability.enabled?(), do: :ok = Presence.join(identity.episode, identity.participant_id)
    Process.send_after(self(), :annotation_tick, @poll_ms)
    state
  end

  def enter(state), do: state

  def initial_snapshot(state), do: refresh(state, true)

  def handle(frame, %{phase: :live} = state) do
    cond do
      not Availability.enabled?() -> disabled(state, frame)
      state.screen_annotation -> handle_negotiated(frame, state)
      true -> Frames.protocol_error(:annotation_not_negotiated, state)
    end
  end

  def handle(_frame, state), do: Frames.protocol_error(:annotation_not_negotiated, state)

  defp handle_negotiated(frame, state) do
    case frame["type"] do
      "annotation_state_request" -> request_state(state)
      "annotation_command" -> command(frame, state)
      "annotation_presence" -> update_presence(frame, state)
    end
  end

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
    if Availability.enabled?(), do: send_presence(state), else: disabled(state)
  end

  def drain_presence(state), do: {:ok, state}

  defp send_presence(state) do
    now = System.system_time(:millisecond)

    frames =
      Enum.filter(Presence.take(), fn frame ->
        matching?(state.annotation, frame, now) and
          (frame["expires_at_ms"] > now or (is_nil(frame["cursor"]) and is_nil(frame["draft"])))
      end)

    Projection.push(state, frames)
  end

  defp refresh(state, forced?) do
    if Availability.enabled?() do
      Projection.refresh(
        Map.delete(state, :annotation_withdrawn),
        forced? or Map.get(state, :annotation_withdrawn, false)
      )
    else
      disabled(state)
    end
  end

  defp disabled(state, frame \\ nil)

  defp disabled(%{attachment: _} = state, _frame), do: stop_disabled_attachment(state)

  defp disabled(state, frame) do
    {state, withdrawal} = withdraw(state)
    Projection.push(state, withdrawal ++ disabled_receipt(frame))
  end

  def stop_disabled_attachment(state),
    do: {:stop, :normal, {1008, "screen_annotation_disabled"}, state}

  defp withdraw(%{screen_annotation: true} = state)
       when not is_map_key(state, :annotation_withdrawn) do
    Presence.leave()

    next =
      state
      |> Map.put(:annotation_withdrawn, true)
      |> Map.put(:annotation, nil)
      |> Map.delete(:annotation_snapshot_request)

    snapshot = Projection.snapshot(nil, System.system_time(:millisecond))

    snapshot =
      if Map.get(state, :screen_annotation_burn_in, false),
        do: Map.put(snapshot, "enabled", false),
        else: snapshot

    {next, [snapshot]}
  end

  defp withdraw(state), do: {state, []}

  # Keep the rejection decodable by already shipped SDKs. An unknown reason would
  # make them recover the whole Sync connection, not just withdraw annotation.
  defp disabled_receipt(%{"type" => "annotation_command", "operation_id" => id}),
    do: [command_receipt(id, receipt({:error, "not_active"}))]

  defp disabled_receipt(_frame), do: []

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

    timestamps = if length(recent) < 24, do: [now | recent], else: recent

    Projection.push(%{state | annotation_commands: timestamps}, [
      command_receipt(frame["operation_id"], response)
    ])
  end

  defp command_receipt(operation_id, result),
    do: %{"type" => "annotation_receipt", "operation_id" => operation_id, "result" => result}

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
end
