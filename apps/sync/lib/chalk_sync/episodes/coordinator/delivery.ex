defmodule ChalkSync.Episodes.Coordinator.Delivery do
  @moduledoc """
  Delivering a published event to every subscribed socket, and catching a socket up after a gap. Every function takes the Coordinator state.
  """

  alias ChalkSync.Episodes.Coordinator.LiveFrames
  alias ChalkSync.Episodes.Coordinator.Outbound
  alias ChalkSync.Episodes.Coordinator.Subscribers
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder
  alias ChalkSync.Telemetry
  alias ChalkSync.Transport.OutboundQueue

  def catch_up_live_sockets(state) do
    {sockets, state} =
      Enum.reduce(state.sockets, {%{}, state}, fn {socket, subscriber}, {kept, current_state} ->
        case catch_up_live_socket(current_state, socket, subscriber) do
          {:ok, next_subscriber, next_state} ->
            {Map.put(kept, socket, next_subscriber), next_state}

          {:error, reason} ->
            Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            Subscribers.close_subscriber(subscriber)
            {kept, current_state}
        end
      end)

    %{state | sockets: sockets}
  end

  defp catch_up_live_socket(state, _socket, %{mode: :recovering} = subscriber) do
    {:ok, subscriber, state}
  end

  defp catch_up_live_socket(state, socket, subscriber) do
    with true <- subscriber.enqueued_revision < state.target_revision,
         true <- Subscribers.unsent_empty?(subscriber.queue),
         {:ok, [_ | _] = events} <-
           Stateholder.recovery_page(
             state.episode,
             subscriber.enqueued_revision,
             state.target_revision
           ) do
      case enqueue_catch_up_events(socket, subscriber, events) do
        {:ok, next_subscriber} -> {:ok, next_subscriber, state}
        {:error, reason} -> {:error, reason}
      end
    else
      false -> {:ok, subscriber, state}
      {:ok, []} -> {:error, :revision_gap}
      {:error, reason} -> {:error, reason}
      {:retryable, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    ArgumentError -> {:error, :invalid_event}
  end

  defp enqueue_catch_up_events(socket, subscriber, events) do
    Enum.reduce_while(events, {:ok, subscriber}, fn event, {:ok, current} ->
      encoded = ProtocolV1.event(event)

      case enqueue_event(socket, current, event, encoded) do
        {:ok, next} -> {:cont, {:ok, next}}
        :duplicate -> {:cont, {:ok, current}}
        {:drop, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  def deliver_event(state, event) do
    revision = Subscribers.field(event, :revision)

    case valid_delivery_revision(state.head, revision) do
      :ok -> {:ok, deliver_encoded_event(state, event, revision)}
      {:error, _reason} -> {:error, state}
    end
  rescue
    ArgumentError -> {:error, state}
  end

  defp valid_delivery_revision(_head, revision) when not is_integer(revision) do
    {:error, :invalid_revision}
  end

  defp valid_delivery_revision(%{revision: head_revision}, revision)
       when revision > head_revision + 1 do
    {:error, :revision_gap}
  end

  defp valid_delivery_revision(_head, _revision) do
    :ok
  end

  defp deliver_encoded_event(state, event, revision) do
    state = state

    sockets =
      Enum.reduce(state.sockets, %{}, fn socket_entry, kept ->
        deliver_to_socket(socket_entry, kept, event)
      end)

    head =
      if is_nil(state.head) or revision > state.head.revision do
        Subscribers.head_from_event(event)
      else
        state.head
      end

    next = %{
      state
      | sockets: sockets,
        head: head,
        target_revision: max(state.target_revision, revision)
    }

    if Subscribers.field(event, :name) in [
         "participant_joined",
         "participant_left",
         "episode_ended"
       ] do
      LiveFrames.start_live_reconcile(next)
    else
      next
    end
  end

  defp deliver_to_socket({socket, subscriber}, kept, event) do
    result =
      if subscriber.mode == :recovering do
        {:ok, subscriber}
      else
        enqueue_event(socket, subscriber, event, ProtocolV1.event(event))
      end

    case result do
      {:ok, next_subscriber} ->
        Map.put(kept, socket, next_subscriber)

      :duplicate ->
        Map.put(kept, socket, subscriber)

      {:drop, reason} ->
        Telemetry.execute([:queue, :overflow], %{}, %{outcome: reason})
        Subscribers.notify_reconnect(socket, reason, subscriber.acknowledged_revision)
        Subscribers.close_subscriber(subscriber)
        kept
    end
  end

  defp enqueue_event(socket, subscriber, event, encoded) do
    revision = Subscribers.field(event, :revision)

    cond do
      revision <= subscriber.enqueued_revision -> :duplicate
      revision != subscriber.enqueued_revision + 1 -> {:drop, :revision_gap}
      true -> reserve_event(socket, subscriber, event, encoded, revision)
    end
  end

  defp reserve_event(socket, subscriber, event, encoded, revision) do
    was_empty? = Subscribers.unsent_empty?(subscriber.queue)

    result =
      OutboundQueue.push(subscriber.queue, encoded,
        revision: revision,
        state_digest:
          event |> Subscribers.field(:resulting_state_digest) |> Subscribers.digest_hex()
      )

    reserved_event(result, socket, subscriber, event, revision, was_empty?)
  end

  defp reserved_event(:ok, socket, subscriber, event, revision, was_empty?) do
    terminal_revision =
      if Subscribers.field(event, :name) == "episode_ended" do
        revision
      else
        subscriber.terminal_revision
      end

    next = %{subscriber | enqueued_revision: revision, terminal_revision: terminal_revision}
    next = next
    notify_reserved_event(socket, next, was_empty?)
  end

  defp reserved_event(
         {:error, {:overflow, reason}},
         _socket,
         _subscriber,
         _event,
         _revision,
         _empty
       ) do
    {:drop, reason}
  end

  defp reserved_event({:error, reason}, _socket, _subscriber, _event, _revision, _empty) do
    {:drop, reason}
  end

  defp notify_reserved_event(socket, subscriber, true) when not subscriber.notified? do
    send(socket, {:sync_outbound_ready, self()})

    {:ok, %{subscriber | notified?: true}}
  end

  defp notify_reserved_event(_socket, subscriber, _was_empty?) do
    {:ok, subscriber}
  end

  def repair(%{head: nil} = state) do
    state
  end

  def repair(state) do
    case Stateholder.recover_episode(state.episode, state.head) do
      {:ok, %{mode: :up_to_date, head: head}} ->
        state
        |> Map.put(:head, head)
        |> Map.put(:target_revision, max(state.target_revision, head.revision))
        |> catch_up_live_sockets()

      {:ok, %{mode: :replay, head: head}} ->
        state
        |> Map.put(:head, head)
        |> Map.put(:target_revision, max(state.target_revision, head.revision))
        |> catch_up_live_sockets()
        |> LiveFrames.start_live_reconcile()

      {:ok, %{mode: :terminal, replay_cursor: cursor, head: head}} when is_integer(cursor) ->
        state
        |> Map.put(:head, head)
        |> Map.put(:target_revision, head.revision)
        |> catch_up_live_sockets()
        |> LiveFrames.start_live_reconcile()

      {:ok, %{mode: mode}} when mode in [:snapshot, :terminal] ->
        Outbound.reconnect_all(state, :authoritative_snapshot_required)

      {:error, _reason} ->
        Outbound.reconnect_all(state, :authoritative_recovery_failed)

      {:retryable, _reason} ->
        state
    end
  end
end
