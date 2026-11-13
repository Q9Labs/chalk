defmodule ChalkSync.Episodes.Coordinator.SocketRecovery.Pop do
  @moduledoc """
  Pops the next recovery frame of a socket and finishes its recovery when the queue drains.
  """

  alias ChalkSync.Episodes.Coordinator.LiveFrames
  alias ChalkSync.Episodes.Coordinator.Subscribers
  alias ChalkSync.Live.Episode, as: LiveEpisode
  alias ChalkSync.Transport.OutboundQueue

  def pop_recovery_socket(state, socket, subscriber) do
    pop =
      if subscriber.recovery.expected_ack do
        :pop
      else
        :take
      end

    case apply(OutboundQueue, pop, [subscriber.queue]) do
      {:ok, entry} ->
        next = mark_recovery_frame_in_flight(subscriber)
        popped_recovery_entry(state, socket, %{next | notified?: false}, entry)

      :empty ->
        {:reply, :empty, state}

      {:error, _reason} ->
        {:reply, {:error, :queue_unavailable}, Subscribers.remove_socket(state, socket)}
    end
  end


  defp popped_recovery_entry(
         state,
         socket,
         %{recovery: %{queued_kind: :terminal_welcome}} = _subscriber,
         entry
       ) do
    {:reply, {:ok, entry.encoded, :terminal_welcome}, Subscribers.remove_socket(state, socket)}
  end

  defp popped_recovery_entry(
         state,
         socket,
         %{recovery: %{queued_kind: :complete}} = subscriber,
         entry
       ) do
    case finish_socket_recovery(state, socket, subscriber) do
      {:reply, :ok, next} -> {:reply, {:ok, entry.encoded, :recovery_complete}, next}
      error -> error
    end
  end

  defp popped_recovery_entry(state, socket, subscriber, entry) do
    if is_nil(subscriber.recovery.expected_ack) do
      send(socket, {:sync_recovery_advance, self()})
    end

    {:reply, {:ok, entry.encoded, false},
     %{state | sockets: Map.put(state.sockets, socket, subscriber)}}
  end


  defp mark_recovery_frame_in_flight(%{recovery: %{expected_ack: nil}} = subscriber) do
    subscriber
  end

  defp mark_recovery_frame_in_flight(subscriber) do
    expected = %{subscriber.recovery.expected_ack | transport_in_flight?: true}
    %{subscriber | recovery: %{subscriber.recovery | expected_ack: expected}}
  end


  defp finish_socket_recovery(
         state,
         socket,
         %{recovery: %{head: head}} = subscriber
       ) do
    case LiveEpisode.register(state.live, subscriber.identity, socket) do
      {:ok, live_state, recovery_frames, broadcast_frames} ->
        live = %{
          subscriber
          | mode: :live,
            recovery: nil,
            enqueued_revision: head.revision,
            acknowledged_revision: head.revision,
            acknowledged_digest: Subscribers.digest_hex(head.digest)
        }

        LiveFrames.send_live_frames(socket, recovery_frames)
        LiveFrames.broadcast_live_frames(live_state, broadcast_frames, except: socket)

        next = %{
          state
          | live: live_state,
            head: head,
            sockets: Map.put(state.sockets, socket, live)
        }

        send(self(), :repair_now)
        {:reply, :ok, next}

      {:error, reason} ->
        Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
        {:reply, {:error, reason}, Subscribers.remove_socket(state, socket)}
    end
  end
end
