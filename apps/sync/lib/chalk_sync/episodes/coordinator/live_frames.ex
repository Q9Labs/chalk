defmodule ChalkSync.Episodes.Coordinator.LiveFrames do
  @moduledoc """
  Live-target reconciliation and the frames it broadcasts to a Coordinator's sockets. Every function takes and returns the Coordinator state.
  """

  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Telemetry

  def expire_live_requests_at(state, now_ms) do
    {live, deliveries} = LiveEpisode.expire_requests(state.live, now_ms)

    Enum.each(deliveries, fn {socket, frame} ->
      send(socket, {:sync_v1_live_frame, self(), frame})
    end)

    %{state | live: live}
  end

  def refresh_after_live_target(live, %{"outcome" => outcome} = result)
      when outcome in ["confirmed", "satisfied"] do
    started = System.monotonic_time(:microsecond)
    reconciled = LiveEpisode.reconcile(live)

    Telemetry.execute(
      [:live_target, :stage],
      %{duration_us: System.monotonic_time(:microsecond) - started},
      %{outcome: :success, stage: :reconcile}
    )

    case reconciled do
      {:ok, next, frames} ->
        broadcast_live_frames(next, frames)
        {next, result}

      {:error, _reason} ->
        {live, retryable_live_result(result)}
    end
  end

  def refresh_after_live_target(live, result) do
    {live, result}
  end

  defp retryable_live_result(result) do
    result
    |> Map.put("outcome", "retryable_failure")
    |> Map.put("error_code", "dependency_unavailable")
  end

  def unregister_live_socket(live, socket) do
    connection_count = map_size(live.connections)
    next = LiveEpisode.unregister(live, socket)

    if map_size(next.connections) < connection_count do
      case LiveEpisode.presence_snapshot(next) do
        {:ok, reconciled, frames} ->
          broadcast_live_frames(reconciled, frames)
          reconciled

        {:error, _reason} ->
          next
      end
    else
      next
    end
  end

  def start_live_reconcile(%{live_reconcile_task: task} = state) when not is_nil(task) do
    %{state | live_reconcile_pending: true}
  end

  def start_live_reconcile(%{live: %{connections: connections}} = state)
      when map_size(connections) == 0 do
    state
  end

  def start_live_reconcile(state) do
    snapshot = state.live

    task =
      Task.Supervisor.async_nolink(ChalkSync.CommandTaskSupervisor, fn ->
        with {:ok, live, media_frames} <- LiveEpisode.reconcile(snapshot),
             {:ok, live, presence_frames} <- LiveEpisode.presence_snapshot(live) do
          {:ok, live, media_frames ++ presence_frames}
        end
      end)

    %{state | live_reconcile_task: %{pid: task.pid, ref: task.ref, live: snapshot}}
  rescue
    _exception -> state
  catch
    :exit, _reason -> state
  end

  def apply_live_reconcile_result(state, snapshot, {:ok, live, frames})
      when state.live == snapshot do
    broadcast_live_frames(live, frames)
    %{state | live: live}
  end

  def apply_live_reconcile_result(state, _snapshot, _result) do
    state
  end

  def broadcast_live_frames(live, frames, options \\ []) do
    excluded = Keyword.get(options, :except)

    for socket <- Map.keys(live.connections), socket != excluded do
      send_live_frames(socket, frames)
    end

    :ok
  end

  def send_live_frames(socket, frames) do
    Enum.each(frames, fn frame ->
      send(socket, {:sync_v1_live_frame, self(), frame})
    end)
  end

  def live_target(state, socket, identity, target) do
    with_live_socket(state, socket, identity, fn ->
      {live, result} = LiveEpisode.live_target(state.live, identity, target)
      {live, result} = refresh_after_live_target(live, result)
      {:reply, {:ok, result}, %{state | live: live}}
    end)
  end

  def directed_request(state, socket, identity, request) do
    with_live_socket(state, socket, identity, fn ->
      {live, result} =
        LiveEpisode.directed_request(
          state.live,
          identity,
          request,
          System.system_time(:millisecond)
        )

      {:reply, {:ok, result}, %{state | live: live}}
    end)
  end

  def acknowledge_request(state, socket, identity, request_id) do
    with_live_socket(state, socket, identity, fn ->
      live =
        LiveEpisode.acknowledge_request(
          state.live,
          identity,
          request_id,
          System.system_time(:millisecond)
        )

      {:reply, :ok, %{state | live: live}}
    end)
  end

  def set_connection_quality(state, socket, identity, quality) do
    with_live_socket(state, socket, identity, fn ->
      case LiveEpisode.set_connection_quality(state.live, socket, quality) do
        {:ok, live, frames} ->
          broadcast_live_frames(live, frames)
          {:reply, :ok, %{state | live: live}}

        {:error, reason} ->
          {:reply, {:error, reason}, state}
      end
    end)
  end

  defp with_live_socket(state, socket, identity, handle) do
    case Map.get(state.sockets, socket) do
      %{mode: :live, identity: ^identity} -> handle.()
      _subscriber -> {:reply, {:error, :not_live}, state}
    end
  end
end
