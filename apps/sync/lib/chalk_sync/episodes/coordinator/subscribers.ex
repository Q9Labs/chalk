defmodule ChalkSync.Episodes.Coordinator.Subscribers do
  @moduledoc """
  Subscriber bookkeeping for a Coordinator: head comparison, queue emptiness and removing a socket. Every function takes and returns the Coordinator state or a subscriber.
  """

  alias ChalkSync.Episodes.Coordinator.LiveFrames
  alias ChalkSync.Transport.OutboundQueue

  def remove_socket(state, socket) do
    case Map.pop(state.sockets, socket) do
      {nil, _sockets} ->
        state

      {subscriber, sockets} ->
        close_subscriber(subscriber)
        live = LiveFrames.unregister_live_socket(state.live, socket)
        %{state | sockets: sockets, live: live}
    end
  end

  def close_subscriber(subscriber) do
    Process.demonitor(subscriber.monitor, [:flush])

    case OutboundQueue.close(subscriber.queue) do
      {:ok, _stats} -> :ok
      {:error, _reason} -> :ok
    end
  end

  def stop_if_empty(state) do
    if map_size(state.sockets) == 0 do
      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  def unsent_empty?(queue) do
    case OutboundQueue.unsent?(queue) do
      {:ok, false} -> true
      _other -> false
    end
  end

  def outstanding_empty?(queue) do
    case OutboundQueue.outstanding?(queue) do
      {:ok, false} -> true
      _other -> false
    end
  end

  def compatible_head?(nil, _head) do
    true
  end

  def compatible_head?(current, head) do
    current.revision != head.revision or current.digest == head.digest
  end

  def older_head(nil, head) do
    head
  end

  def older_head(current, head) when head.revision < current.revision do
    head
  end

  def older_head(current, _head) do
    current
  end

  def head_from_event(event) do
    %{
      revision: field(event, :revision),
      state_schema_version: field(event, :schema_version),
      digest: field(event, :resulting_state_digest)
    }
  end

  def digest_hex(<<_digest::binary-size(32)>> = digest) do
    Base.encode16(digest, case: :lower)
  end

  def digest_hex(<<digest::binary-size(64)>>) do
    String.downcase(digest)
  end

  def notify_reconnect(socket, reason, revision) do
    send(socket, {:sync_outbound_overflow, reason, revision})
  end

  def field(map, key) do
    Map.get(map, key, Map.get(map, Atom.to_string(key)))
  end

  def subscribe(state, socket, head) do
    state = remove_socket(state, socket)

    if compatible_head?(state.head, head) do
      queue = OutboundQueue.new()
      monitor = Process.monitor(socket)

      subscriber = %{
        queue: queue,
        monitor: monitor,
        mode: :live,
        identity: nil,
        recovery: nil,
        enqueued_revision: head.revision,
        acknowledged_revision: head.revision,
        acknowledged_digest: digest_hex(head.digest),
        notified?: false,
        draining?: false,
        terminal_revision: nil
      }

      state = %{
        state
        | head: older_head(state.head, head),
          target_revision: max(state.target_revision, head.revision),
          sockets: Map.put(state.sockets, socket, subscriber)
      }

      send(self(), :repair_now)
      {:reply, {:ok, self()}, state}
    else
      {:reply, {:error, :state_digest_mismatch}, state}
    end
  end

  def begin_recovery(state, socket, identity, protocol_options) do
    state = remove_socket(state, socket)

    subscriber = %{
      queue: OutboundQueue.new(),
      monitor: Process.monitor(socket),
      mode: :recovering,
      identity: identity,
      protocol_options: protocol_options,
      recovery: nil,
      optional_recovery_ack: nil,
      enqueued_revision: 0,
      acknowledged_revision: 0,
      acknowledged_digest: nil,
      notified?: false,
      draining?: false,
      terminal_revision: nil
    }

    {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, subscriber)}}
  end
end
