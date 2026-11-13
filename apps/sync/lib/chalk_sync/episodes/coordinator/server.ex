defmodule ChalkSync.Episodes.Coordinator.Server do
  @moduledoc false

  use GenServer

  alias ChalkSync.Episodes.Coordinator.Delivery
  alias ChalkSync.Episodes.Coordinator.LiveFrames
  alias ChalkSync.Episodes.Coordinator.Outbound
  alias ChalkSync.Episodes.Coordinator.SocketRecovery
  alias ChalkSync.Episodes.Coordinator.SocketRecovery.Pop
  alias ChalkSync.Episodes.Coordinator.Subscribers
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Stateholder.EpisodeKey

  @repair_interval_ms 5000
  @queue_check_interval_ms 1000
  @live_reconcile_interval_ms 15_000

  @impl GenServer
  def init(episode) do
    Process.send_after(self(), :repair, @repair_interval_ms)
    Process.send_after(self(), :check_queues, @queue_check_interval_ms)
    Process.send_after(self(), :expire_live_requests, @queue_check_interval_ms)
    Process.send_after(self(), :reconcile_live, @live_reconcile_interval_ms)

    {:ok,
     %{
       episode: episode,
       head: nil,
       target_revision: 0,
       sockets: %{},
       live: LiveEpisode.new(episode),
       live_reconcile_task: nil,
       live_reconcile_pending: false
     }}
  end

  @impl GenServer
  def handle_call({:subscribe, socket, head}, _from, state),
    do: Subscribers.subscribe(state, socket, head)

  def handle_call({:begin_recovery, socket, identity, protocol_options}, _from, state),
    do: Subscribers.begin_recovery(state, socket, identity, protocol_options)

  def handle_call({:activate_recovery, socket, recovery}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{mode: :recovering, recovery: nil} = subscriber} ->
        SocketRecovery.activate_socket_recovery(state, socket, subscriber, recovery)

      _other ->
        {:reply, {:error, :not_recovering}, state}
    end
  end

  def handle_call({:advance_recovery, socket}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{mode: :recovering} = subscriber} ->
        case SocketRecovery.enqueue_next_recovery_frame(socket, subscriber) do
          {:ok, next_subscriber} ->
            {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}

          {:error, reason} ->
            Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            {:reply, {:error, reason}, Subscribers.remove_socket(state, socket)}
        end

      _other ->
        {:reply, {:error, :not_recovering}, state}
    end
  end

  def handle_call({:publish, event}, _from, state) do
    case Delivery.deliver_event(state, event) do
      {:ok, next} ->
        {:reply, :ok, next}

      {:error, next} ->
        send(self(), :repair_now)
        {:reply, {:error, :revision_gap}, next}
    end
  end

  def handle_call({:publish_pending, socket, event}, _from, state) do
    previous_revision =
      case Map.get(state.sockets, socket) do
        %{mode: :live, identity: %{protocol_version: 1}, enqueued_revision: revision} -> revision
        _subscriber -> nil
      end

    with revision when is_integer(revision) <- Subscribers.field(event, :revision),
         {:ok, delivered} <- Delivery.deliver_event(state, event),
         {:ok, frames, next} <-
           Outbound.pending_event_frames(delivered, socket, previous_revision, revision) do
      {:reply, {:ok, frames}, next}
    else
      _error ->
        send(self(), :repair_now)
        {:reply, {:error, :revision_gap}, state}
    end
  end

  def handle_call({:pop, socket}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      :error ->
        {:reply, {:error, :not_subscribed}, state}

      {:ok, subscriber} ->
        if subscriber.mode == :recovering do
          Pop.pop_recovery_socket(state, socket, subscriber)
        else
          Outbound.pop_socket(state, socket, subscriber)
        end
    end
  end

  def handle_call({:acknowledge, socket, revision, state_digest}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      :error ->
        {:reply, {:error, :not_subscribed}, state}

      {:ok, subscriber} ->
        Outbound.acknowledge_socket(state, socket, subscriber, revision, state_digest)
    end
  end

  def handle_call(
        {:acknowledge_recovery, socket, recovery_id, revision, state_digest},
        _from,
        state
      ) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{optional_recovery_ack: {^recovery_id, ^revision, ^state_digest}}} ->
        # Published 4.1 clients acknowledge up-to-date welcomes. It is optional:
        # exact duplicates neither release credit nor advance recovery.
        {:reply, :ok, state}

      {:ok, %{mode: :recovering} = subscriber} ->
        SocketRecovery.acknowledge_recovery_frame(
          state,
          socket,
          subscriber,
          recovery_id,
          revision,
          state_digest
        )

      _ ->
        {:reply, {:error, :not_recovering}, state}
    end
  end

  def handle_call({:live_target, socket, identity, target}, _from, state),
    do: LiveFrames.live_target(state, socket, identity, target)

  def handle_call({:directed_request, socket, identity, request}, _from, state),
    do: LiveFrames.directed_request(state, socket, identity, request)

  def handle_call({:acknowledge_request, socket, identity, request_id}, _from, state),
    do: LiveFrames.acknowledge_request(state, socket, identity, request_id)

  def handle_call({:set_connection_quality, socket, identity, quality}, _from, state),
    do: LiveFrames.set_connection_quality(state, socket, identity, quality)

  def handle_call({:expire_live_requests, now_ms}, _from, state) do
    {:reply, :ok, LiveFrames.expire_live_requests_at(state, now_ms)}
  end

  def handle_call(:reconcile_live, _from, state) do
    {:reply, :ok, LiveFrames.start_live_reconcile(state)}
  end

  @impl GenServer
  def handle_cast({:unsubscribe, socket}, state) do
    Subscribers.stop_if_empty(Subscribers.remove_socket(state, socket))
  end

  def handle_cast({:publication_observed, space_id}, state) do
    if String.downcase(space_id) == String.downcase(state.episode.space_id) do
      handle_cast(:publication_observed, state)
    else
      {:noreply, state}
    end
  end

  def handle_cast(:publication_observed, %{live_reconcile_task: task} = state)
      when not is_nil(task) do
    {:noreply, %{state | live_reconcile_pending: true}}
  end

  def handle_cast(:publication_observed, state) do
    {:noreply, LiveFrames.start_live_reconcile(state)}
  end

  def handle_cast(:drain, state) do
    state |> Outbound.drain_sockets() |> Subscribers.stop_if_empty()
  end

  def handle_cast({:hint, revision}, state) do
    if revision > state.target_revision do
      send(self(), :repair_now)
    end

    {:noreply, %{state | target_revision: max(state.target_revision, revision)}}
  end

  @impl GenServer
  def handle_info(:repair, state),
    do: state |> Delivery.repair() |> reschedule(:repair, @repair_interval_ms)

  def handle_info(:repair_now, state),
    do: state |> Delivery.repair() |> Subscribers.stop_if_empty()

  def handle_info(:check_queues, state),
    do:
      state |> Outbound.check_queue_ages() |> reschedule(:check_queues, @queue_check_interval_ms)

  def handle_info(:expire_live_requests, state) do
    state
    |> LiveFrames.expire_live_requests_at(System.system_time(:millisecond))
    |> reschedule(:expire_live_requests, @queue_check_interval_ms)
  end

  def handle_info(:reconcile_live, state),
    do:
      state
      |> LiveFrames.start_live_reconcile()
      |> reschedule(:reconcile_live, @live_reconcile_interval_ms)

  def handle_info(
        {reference, result},
        %{live_reconcile_task: %{ref: reference, live: snapshot}} = state
      ) do
    Process.demonitor(reference, [:flush])
    rerun = state.live_reconcile_pending or state.live != snapshot
    state = %{state | live_reconcile_task: nil, live_reconcile_pending: false}
    state = LiveFrames.apply_live_reconcile_result(state, snapshot, result)

    {:noreply,
     if rerun do
       LiveFrames.start_live_reconcile(state)
     else
       state
     end}
  end

  def handle_info(
        {:DOWN, reference, :process, _pid, _reason},
        %{live_reconcile_task: %{ref: reference}} = state
      ) do
    rerun = state.live_reconcile_pending
    state = %{state | live_reconcile_task: nil, live_reconcile_pending: false}

    {:noreply,
     if rerun do
       LiveFrames.start_live_reconcile(state)
     else
       state
     end}
  end

  def handle_info({:DOWN, monitor, :process, socket, _reason}, state) do
    case Map.get(state.sockets, socket) do
      %{monitor: ^monitor} -> Subscribers.stop_if_empty(Subscribers.remove_socket(state, socket))
      _other -> {:noreply, state}
    end
  end

  @impl GenServer
  def terminate(_reason, state) do
    # Withdraw synchronously before DOWN: Registry's automatic cleanup is asynchronous.
    Registry.unregister(ChalkSync.Episodes.Registry, EpisodeKey.authority_key(state.episode))
  end

  defp reschedule(state, message, interval_ms) do
    with {:noreply, state} <- Subscribers.stop_if_empty(state) do
      Process.send_after(self(), message, interval_ms)
      {:noreply, state}
    end
  end
end
