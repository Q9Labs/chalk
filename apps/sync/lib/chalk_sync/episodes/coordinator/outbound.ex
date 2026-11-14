defmodule ChalkSync.Episodes.Coordinator.Outbound do
  @moduledoc """
  Popping and acknowledging a socket's outbound frames, aging out stalled queues and draining sockets. Every function takes the Coordinator state.
  """

  alias ChalkSync.Episodes.Coordinator.Subscribers
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Transport.OutboundQueue

  def pop_socket(state, socket, subscriber) do
    case OutboundQueue.pop(subscriber.queue) do
      {:ok, entry} ->
        popped_entry(state, socket, subscriber, entry)

      :empty ->
        next = %{subscriber | notified?: false}
        {:reply, :empty, %{state | sockets: Map.put(state.sockets, socket, next)}}

      {:error, _reason} ->
        next = Subscribers.remove_socket(state, socket)
        {:reply, {:error, :queue_unavailable}, next}
    end
  end

  defp popped_entry(
         state,
         socket,
         %{terminal_revision: revision} = subscriber,
         %{revision: revision, state_digest: state_digest, encoded: encoded}
       )
       when is_integer(revision) and is_binary(state_digest) do
    {state, subscriber} = {state, subscriber}
    next_subscriber = Map.put(subscriber, :notified?, false)

    {:reply, {:ok, encoded, {:terminal, revision, state_digest}},
     %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}
  end

  defp popped_entry(state, socket, subscriber, entry) do
    more? = not Subscribers.unsent_empty?(subscriber.queue)
    {state, subscriber} = {state, subscriber}
    next_subscriber = Map.put(subscriber, :notified?, more?)

    if more? do
      send(socket, {:sync_outbound_ready, self()})
    end

    {:reply, {:ok, entry.encoded, false},
     %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}
  end

  def pending_event_frames(state, _socket, previous_revision, revision)
      when is_integer(previous_revision) and revision <= previous_revision do
    {:ok, [], state}
  end

  def pending_event_frames(state, socket, _previous_revision, revision) do
    case Map.fetch(state.sockets, socket) do
      {:ok, subscriber} -> pop_pending_frames(state, socket, subscriber, revision, [])
      :error -> {:error, :not_subscribed}
    end
  end

  defp pop_pending_frames(state, socket, subscriber, revision, frames) do
    case OutboundQueue.pop(subscriber.queue) do
      {:ok, %{encoded: encoded, revision: current}} when current < revision ->
        pop_pending_frames(state, socket, subscriber, revision, [encoded | frames])

      {:ok, %{encoded: encoded, revision: ^revision}} ->
        next_subscriber = %{subscriber | notified?: false}

        {:ok, Enum.reverse([encoded | frames]),
         %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}

      {:ok, _later} ->
        {:error, :revision_gap}

      :empty ->
        {:error, :revision_gap}

      {:error, _reason} ->
        {:error, :queue_unavailable}
    end
  end

  def acknowledge_socket(state, socket, subscriber, revision, state_digest) do
    cond do
      revision < subscriber.acknowledged_revision ->
        {:reply, :ok, state}

      revision == subscriber.acknowledged_revision ->
        acknowledge_current(state, subscriber, state_digest)

      revision > subscriber.enqueued_revision ->
        {:reply, {:error, :unknown_ack}, state}

      true ->
        acknowledge_new(state, socket, subscriber, revision, state_digest)
    end
  end

  defp acknowledge_current(state, %{acknowledged_digest: digest}, digest) do
    {:reply, :ok, state}
  end

  defp acknowledge_current(state, _subscriber, _digest) do
    {:reply, {:error, :digest_mismatch}, state}
  end

  defp acknowledge_new(state, socket, subscriber, revision, state_digest) do
    subscriber.queue
    |> OutboundQueue.ack(revision, state_digest)
    |> acknowledged_result(state, socket, subscriber, revision, state_digest)
  end

  defp acknowledged_result(
         {:ok, %{queued_events: 0}},
         state,
         socket,
         %{draining?: true} = subscriber,
         revision,
         state_digest
       ) do
    next = store_ack(state, socket, subscriber, revision, state_digest)
    send(socket, {:sync_server_drained, self()})
    {:reply, :ok, Subscribers.remove_socket(next, socket)}
  end

  defp acknowledged_result(
         {:ok, _stats},
         state,
         socket,
         subscriber,
         revision,
         state_digest
       ) do
    if subscriber.enqueued_revision < state.target_revision do
      send(self(), :repair_now)
    end

    {:reply, :ok, store_ack(state, socket, subscriber, revision, state_digest)}
  end

  defp acknowledged_result(
         {:error, {:overflow, reason}},
         state,
         socket,
         subscriber,
         _revision,
         _state_digest
       ) do
    Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
    {:reply, {:error, reason}, Subscribers.remove_socket(state, socket)}
  end

  defp acknowledged_result(
         {:error, reason},
         state,
         _socket,
         _subscriber,
         _revision,
         _state_digest
       ) do
    {:reply, {:error, reason}, state}
  end

  defp store_ack(state, socket, subscriber, revision, state_digest) do
    {state, subscriber} = {state, subscriber}

    next_subscriber = %{
      subscriber
      | acknowledged_revision: revision,
        acknowledged_digest: state_digest
    }

    %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}
  end

  def check_queue_ages(state) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn {socket, subscriber}, kept ->
        case OutboundQueue.stats(subscriber.queue) do
          {:ok, _stats} ->
            Map.put(kept, socket, subscriber)

          {:error, {:overflow, reason}} ->
            Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            Subscribers.close_subscriber(subscriber)
            kept

          {:error, _reason} ->
            Subscribers.notify_reconnect(
              socket,
              :queue_unavailable,
              subscriber.acknowledged_revision
            )

            Subscribers.close_subscriber(subscriber)
            kept
        end
      end)

    %{state | sockets: sockets}
  end

  def drain_sockets(state) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn socket_entry, kept ->
        drain_socket(socket_entry, kept)
      end)

    %{state | sockets: sockets}
  end

  defp drain_socket({socket, subscriber}, kept) do
    if Subscribers.outstanding_empty?(subscriber.queue) do
      send(socket, {:sync_server_drained, self()})
      Subscribers.close_subscriber(subscriber)
      kept
    else
      retain_draining_socket(socket, subscriber, kept)
    end
  end

  defp retain_draining_socket(socket, subscriber, kept) do
    unsent? = not Subscribers.unsent_empty?(subscriber.queue)
    notify? = not subscriber.notified? and unsent?

    if notify? do
      send(socket, {:sync_outbound_ready, self()})
    end

    Map.put(kept, socket, %{
      subscriber
      | draining?: true,
        notified?: subscriber.notified? or unsent?
    })
  end

  def reconnect_all(state, reason) do
    Enum.each(state.sockets, fn {socket, subscriber} ->
      Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
      Subscribers.close_subscriber(subscriber)
    end)

    live = Enum.reduce(Map.keys(state.sockets), state.live, &LiveEpisode.unregister(&2, &1))
    %{state | sockets: %{}, live: live}
  end
end
