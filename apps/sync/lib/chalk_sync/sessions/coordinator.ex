defmodule ChalkSync.Sessions.Coordinator do
  @moduledoc """
  Disposable node-local delivery coordinator for one durable Session.

  PostgreSQL remains authoritative. The coordinator owns only bounded socket
  queues, coalesced head repair, and exact-next local delivery. Losing this
  process forces normal recovery and cannot lose a durable event or decision.
  """

  use GenServer

  alias ChalkSync.ProtocolV2
  alias ChalkSync.Stateholder
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.Telemetry
  alias ChalkSync.Transport.OutboundQueue

  @repair_interval_ms 5_000
  @queue_check_interval_ms 1_000

  def start_link(%SessionKey{} = session) do
    GenServer.start_link(__MODULE__, session, name: via(session))
  end

  def child_spec(%SessionKey{} = session) do
    %{
      id: {__MODULE__, SessionKey.authority_key(session)},
      start: {__MODULE__, :start_link, [session]},
      restart: :temporary
    }
  end

  @spec subscribe(Identity.t(), map(), pid()) :: {:ok, pid()} | {:error, atom()}
  def subscribe(%Identity{} = identity, head, socket \\ self()) when is_pid(socket) do
    with {:ok, coordinator} <- ensure_started(identity.session) do
      GenServer.call(coordinator, {:subscribe, socket, head}, 3_000)
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec begin_recovery(Identity.t(), pid()) :: {:ok, pid()} | {:error, atom()}
  def begin_recovery(%Identity{} = identity, socket \\ self()) when is_pid(socket) do
    with {:ok, coordinator} <- ensure_started(identity.session),
         :ok <- GenServer.call(coordinator, {:begin_recovery, socket, identity}, 3_000) do
      {:ok, coordinator}
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec activate_recovery(pid(), Recovery.t(), pid()) :: :ok | {:error, atom()}
  def activate_recovery(coordinator, %Recovery{} = recovery, socket \\ self()) do
    GenServer.call(coordinator, {:activate_recovery, socket, recovery}, 3_000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec advance_recovery(pid(), pid()) :: :ok | {:error, atom()}
  def advance_recovery(coordinator, socket \\ self()) do
    GenServer.call(coordinator, {:advance_recovery, socket}, 3_000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec unsubscribe(pid(), pid()) :: :ok
  def unsubscribe(coordinator, socket \\ self()) do
    GenServer.cast(coordinator, {:unsubscribe, socket})
  end

  @spec publish(SessionKey.t(), map()) :: :ok | {:error, atom()}
  def publish(%SessionKey{} = session, event) when is_map(event) do
    case whereis(session) do
      nil -> :ok
      coordinator -> GenServer.call(coordinator, {:publish, event}, 3_000)
    end
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec hint(SessionKey.t(), non_neg_integer()) :: :ok
  def hint(%SessionKey{} = session, revision) when is_integer(revision) and revision >= 0 do
    case whereis(session) do
      nil -> :ok
      coordinator -> GenServer.cast(coordinator, {:hint, revision})
    end
  end

  @spec pop(pid(), pid()) :: {:ok, binary(), boolean()} | :empty | {:error, atom()}
  def pop(coordinator, socket \\ self()) do
    GenServer.call(coordinator, {:pop, socket}, 1_000)
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec acknowledge(pid(), pos_integer(), String.t(), pid()) :: :ok | {:error, atom()}
  def acknowledge(coordinator, revision, state_digest, socket \\ self())
      when is_integer(revision) and revision >= 1 and is_binary(state_digest) do
    GenServer.call(
      coordinator,
      {:acknowledge, socket, revision, state_digest},
      1_000
    )
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec acknowledge_recovery(pid(), String.t(), non_neg_integer(), String.t(), pid()) ::
          :ok | {:error, atom()}
  def acknowledge_recovery(
        coordinator,
        recovery_id,
        revision,
        state_digest,
        socket \\ self()
      )
      when is_binary(recovery_id) and is_integer(revision) and revision >= 0 and
             is_binary(state_digest) do
    GenServer.call(
      coordinator,
      {:acknowledge_recovery, socket, recovery_id, revision, state_digest},
      1_000
    )
  catch
    :exit, _reason -> {:error, :coordinator_unavailable}
  end

  @spec whereis(SessionKey.t()) :: pid() | nil
  def whereis(%SessionKey{} = session) do
    case Registry.lookup(ChalkSync.Sessions.Registry, SessionKey.authority_key(session)) do
      [{pid, _value}] -> pid
      [] -> nil
    end
  end

  @spec drain_all() :: :ok
  def drain_all do
    ChalkSync.Sessions.Supervisor
    |> DynamicSupervisor.which_children()
    |> Enum.each(fn {_id, pid, _type, _modules} -> GenServer.cast(pid, :drain) end)

    :ok
  catch
    :exit, _reason -> :ok
  end

  @impl GenServer
  def init(session) do
    Process.send_after(self(), :repair, @repair_interval_ms)
    Process.send_after(self(), :check_queues, @queue_check_interval_ms)

    {:ok, %{session: session, head: nil, target_revision: 0, sockets: %{}}}
  end

  @impl GenServer
  def handle_call({:subscribe, socket, head}, _from, state) do
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

  def handle_call({:begin_recovery, socket, identity}, _from, state) do
    state = remove_socket(state, socket)

    subscriber = %{
      queue: OutboundQueue.new(),
      monitor: Process.monitor(socket),
      mode: :recovering,
      identity: identity,
      recovery: nil,
      enqueued_revision: 0,
      acknowledged_revision: 0,
      acknowledged_digest: nil,
      notified?: false,
      draining?: false,
      terminal_revision: nil
    }

    {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, subscriber)}}
  end

  def handle_call({:activate_recovery, socket, recovery}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{mode: :recovering, recovery: nil} = subscriber} ->
        activate_socket_recovery(state, socket, subscriber, recovery)

      _other ->
        {:reply, {:error, :not_recovering}, state}
    end
  end

  def handle_call({:advance_recovery, socket}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{mode: :recovering, recovery: %{queued_kind: :complete}} = subscriber} ->
        finish_socket_recovery(state, socket, subscriber)

      {:ok, %{mode: :recovering} = subscriber} ->
        case enqueue_next_recovery_frame(socket, subscriber) do
          {:ok, next_subscriber} ->
            {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}

          {:error, reason} ->
            notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            {:reply, {:error, reason}, remove_socket(state, socket)}
        end

      _other ->
        {:reply, {:error, :not_recovering}, state}
    end
  end

  def handle_call({:publish, event}, _from, state) do
    case deliver_event(state, event) do
      {:ok, next} ->
        {:reply, :ok, next}

      {:error, next} ->
        send(self(), :repair_now)
        {:reply, {:error, :revision_gap}, next}
    end
  end

  def handle_call({:pop, socket}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      :error ->
        {:reply, {:error, :not_subscribed}, state}

      {:ok, subscriber} ->
        if subscriber.mode == :recovering,
          do: pop_recovery_socket(state, socket, subscriber),
          else: pop_socket(state, socket, subscriber)
    end
  end

  def handle_call({:acknowledge, socket, revision, state_digest}, _from, state) do
    case Map.fetch(state.sockets, socket) do
      :error ->
        {:reply, {:error, :not_subscribed}, state}

      {:ok, subscriber} ->
        acknowledge_socket(state, socket, subscriber, revision, state_digest)
    end
  end

  def handle_call(
        {:acknowledge_recovery, socket, recovery_id, revision, state_digest},
        _from,
        state
      ) do
    case Map.fetch(state.sockets, socket) do
      {:ok, %{mode: :recovering} = subscriber} ->
        acknowledge_recovery_frame(
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

  @impl GenServer
  def handle_cast({:unsubscribe, socket}, state), do: stop_if_empty(remove_socket(state, socket))

  def handle_cast(:drain, state) do
    state
    |> drain_sockets()
    |> stop_if_empty()
  end

  def handle_cast({:hint, revision}, state) do
    if revision > state.target_revision, do: send(self(), :repair_now)
    {:noreply, %{state | target_revision: max(state.target_revision, revision)}}
  end

  @impl GenServer
  def handle_info(:repair, state) do
    state = repair(state)

    if map_size(state.sockets) == 0 do
      {:stop, :normal, state}
    else
      Process.send_after(self(), :repair, @repair_interval_ms)
      {:noreply, state}
    end
  end

  def handle_info(:repair_now, state) do
    state = repair(state)

    if map_size(state.sockets) == 0,
      do: {:stop, :normal, state},
      else: {:noreply, state}
  end

  def handle_info(:check_queues, state) do
    state = check_queue_ages(state)

    if map_size(state.sockets) == 0 do
      {:stop, :normal, state}
    else
      Process.send_after(self(), :check_queues, @queue_check_interval_ms)
      {:noreply, state}
    end
  end

  def handle_info({:DOWN, monitor, :process, socket, _reason}, state) do
    case Map.get(state.sockets, socket) do
      %{monitor: ^monitor} -> stop_if_empty(remove_socket(state, socket))
      _other -> {:noreply, state}
    end
  end

  defp ensure_started(session) do
    case whereis(session) do
      nil ->
        case DynamicSupervisor.start_child(ChalkSync.Sessions.Supervisor, {__MODULE__, session}) do
          {:ok, pid} -> {:ok, pid}
          {:error, {:already_started, pid}} -> {:ok, pid}
          {:error, reason} -> {:error, reason}
        end

      pid ->
        {:ok, pid}
    end
  end

  defp repair(%{head: nil} = state), do: state

  defp repair(state) do
    case Stateholder.recover_session(state.session, state.head) do
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

      {:ok, %{mode: :terminal, replay_cursor: cursor, head: head}}
      when is_integer(cursor) ->
        state
        |> Map.put(:head, head)
        |> Map.put(:target_revision, head.revision)
        |> catch_up_live_sockets()

      {:ok, %{mode: mode}} when mode in [:snapshot, :terminal] ->
        reconnect_all(state, :authoritative_snapshot_required)

      {:error, _reason} ->
        reconnect_all(state, :authoritative_recovery_failed)

      {:retryable, _reason} ->
        state
    end
  end

  defp catch_up_live_sockets(state) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn {socket, subscriber}, kept ->
        case catch_up_live_socket(state, socket, subscriber) do
          {:ok, next_subscriber} ->
            Map.put(kept, socket, next_subscriber)

          {:error, reason} ->
            notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            close_subscriber(subscriber)
            kept
        end
      end)

    %{state | sockets: sockets}
  end

  defp catch_up_live_socket(_state, _socket, %{mode: :recovering} = subscriber),
    do: {:ok, subscriber}

  defp catch_up_live_socket(state, socket, subscriber) do
    with true <- subscriber.enqueued_revision < state.target_revision,
         true <- unsent_empty?(subscriber.queue),
         {:ok, [_ | _] = events} <-
           Stateholder.recovery_page(
             state.session,
             subscriber.enqueued_revision,
             state.target_revision
           ) do
      enqueue_catch_up_events(socket, subscriber, events)
    else
      false -> {:ok, subscriber}
      {:ok, []} -> {:error, :revision_gap}
      {:error, reason} -> {:error, reason}
      {:retryable, _reason} -> {:error, :dependency_unavailable}
    end
  rescue
    ArgumentError -> {:error, :invalid_event}
  end

  defp enqueue_catch_up_events(socket, subscriber, events) do
    Enum.reduce_while(events, {:ok, subscriber}, fn event, {:ok, current} ->
      encoded = ProtocolV2.event(event)

      case enqueue_event(socket, current, event, encoded) do
        {:ok, next} -> {:cont, {:ok, next}}
        :duplicate -> {:cont, {:ok, current}}
        {:drop, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp deliver_event(state, event) do
    revision = field(event, :revision)

    with :ok <- valid_delivery_revision(state.head, revision),
         {:ok, encoded} <- encode_event(event) do
      {:ok, deliver_encoded_event(state, event, encoded, revision)}
    else
      {:error, _reason} -> {:error, state}
    end
  end

  defp valid_delivery_revision(_head, revision) when not is_integer(revision),
    do: {:error, :invalid_revision}

  defp valid_delivery_revision(%{revision: head_revision}, revision)
       when revision > head_revision + 1,
       do: {:error, :revision_gap}

  defp valid_delivery_revision(_head, _revision), do: :ok

  defp deliver_encoded_event(state, event, encoded, revision) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn socket_entry, kept ->
        deliver_to_socket(socket_entry, kept, event, encoded)
      end)

    head =
      if is_nil(state.head) or revision > state.head.revision,
        do: head_from_event(event),
        else: state.head

    %{
      state
      | sockets: sockets,
        head: head,
        target_revision: max(state.target_revision, revision)
    }
  end

  defp deliver_to_socket({socket, subscriber}, kept, event, encoded) do
    result =
      if subscriber.mode == :recovering,
        do: {:ok, subscriber},
        else: enqueue_event(socket, subscriber, event, encoded)

    case result do
      {:ok, next_subscriber} ->
        Map.put(kept, socket, next_subscriber)

      :duplicate ->
        Map.put(kept, socket, subscriber)

      {:drop, reason} ->
        Telemetry.execute([:queue, :overflow], %{}, %{outcome: reason})
        notify_reconnect(socket, reason, subscriber.acknowledged_revision)
        close_subscriber(subscriber)
        kept
    end
  end

  defp enqueue_event(socket, subscriber, event, encoded) do
    revision = field(event, :revision)

    cond do
      revision <= subscriber.enqueued_revision -> :duplicate
      revision != subscriber.enqueued_revision + 1 -> {:drop, :revision_gap}
      true -> reserve_event(socket, subscriber, event, encoded, revision)
    end
  end

  defp reserve_event(socket, subscriber, event, encoded, revision) do
    was_empty? = unsent_empty?(subscriber.queue)

    result =
      OutboundQueue.push(subscriber.queue, encoded,
        revision: revision,
        state_digest: event |> field(:resulting_state_digest) |> digest_hex()
      )

    reserved_event(result, socket, subscriber, event, revision, was_empty?)
  end

  defp reserved_event(:ok, socket, subscriber, event, revision, was_empty?) do
    terminal_revision =
      if field(event, :name) == "session_ended",
        do: revision,
        else: subscriber.terminal_revision

    next = %{
      subscriber
      | enqueued_revision: revision,
        terminal_revision: terminal_revision
    }

    notify_reserved_event(socket, next, was_empty?)
  end

  defp reserved_event(
         {:error, {:overflow, reason}},
         _socket,
         _subscriber,
         _event,
         _revision,
         _empty
       ),
       do: {:drop, reason}

  defp reserved_event({:error, reason}, _socket, _subscriber, _event, _revision, _empty),
    do: {:drop, reason}

  defp notify_reserved_event(socket, subscriber, true) when not subscriber.notified? do
    send(socket, {:sync_outbound_ready, self()})
    {:ok, %{subscriber | notified?: true}}
  end

  defp notify_reserved_event(_socket, subscriber, _was_empty?), do: {:ok, subscriber}

  defp activate_socket_recovery(state, socket, subscriber, recovery) do
    if compatible_head?(state.head, recovery.head) do
      recovery_id = ProtocolV2.recovery_id()
      encoded = ProtocolV2.recovery_welcome(subscriber.identity, recovery, recovery_id)

      recovery_state = %{
        mode: recovery.mode,
        head: recovery.head,
        id: recovery_id,
        cursor: recovery.replay_cursor,
        queued_kind: if(recovery.mode == :terminal, do: :terminal_welcome, else: :welcome),
        expected_ack: nil
      }

      next_subscriber = %{subscriber | recovery: recovery_state}

      acknowledgement =
        if recovery.mode == :snapshot do
          %{
            recovery_id: recovery_id,
            revision: recovery.head.revision,
            state_digest: digest_hex(recovery.head.digest),
            queued_kind: :welcome,
            transport_in_flight?: false
          }
        end

      case reserve_recovery_frame(socket, next_subscriber, encoded, false, acknowledgement) do
        {:ok, reserved} ->
          next = %{
            state
            | head: older_head(state.head, recovery.head),
              target_revision: max(state.target_revision, recovery.head.revision),
              sockets: Map.put(state.sockets, socket, reserved)
          }

          {:reply, :ok, next}

        {:error, reason} ->
          {:reply, {:error, reason}, remove_socket(state, socket)}
      end
    else
      {:reply, {:error, :state_digest_mismatch}, remove_socket(state, socket)}
    end
  rescue
    ArgumentError -> {:reply, {:error, :invalid_recovery}, remove_socket(state, socket)}
  end

  defp pop_recovery_socket(state, socket, subscriber) do
    pop = if subscriber.recovery.expected_ack, do: :pop, else: :take

    case apply(OutboundQueue, pop, [subscriber.queue]) do
      {:ok, entry} ->
        next = mark_recovery_frame_in_flight(subscriber)
        popped_recovery_entry(state, socket, %{next | notified?: false}, entry)

      :empty ->
        {:reply, :empty, state}

      {:error, _reason} ->
        {:reply, {:error, :queue_unavailable}, remove_socket(state, socket)}
    end
  end

  defp popped_recovery_entry(
         state,
         socket,
         %{recovery: %{queued_kind: :terminal_welcome}} = _subscriber,
         entry
       ) do
    {:reply, {:ok, entry.encoded, true}, remove_socket(state, socket)}
  end

  defp popped_recovery_entry(state, socket, subscriber, entry) do
    if is_nil(subscriber.recovery.expected_ack) do
      send(socket, {:sync_recovery_advance, self()})
    end

    {:reply, {:ok, entry.encoded, false},
     %{state | sockets: Map.put(state.sockets, socket, subscriber)}}
  end

  defp mark_recovery_frame_in_flight(%{recovery: %{expected_ack: nil}} = subscriber),
    do: subscriber

  defp mark_recovery_frame_in_flight(subscriber) do
    expected = %{subscriber.recovery.expected_ack | transport_in_flight?: true}
    %{subscriber | recovery: %{subscriber.recovery | expected_ack: expected}}
  end

  defp finish_socket_recovery(
         state,
         socket,
         %{recovery: %{head: head}} = subscriber
       ) do
    live = %{
      subscriber
      | mode: :live,
        identity: nil,
        recovery: nil,
        enqueued_revision: head.revision,
        acknowledged_revision: head.revision,
        acknowledged_digest: digest_hex(head.digest)
    }

    next = %{state | sockets: Map.put(state.sockets, socket, live)}
    send(socket, {:sync_recovery_live, self()})
    send(self(), :repair_now)
    {:reply, :ok, next}
  end

  defp enqueue_next_recovery_frame(
         socket,
         %{recovery: %{mode: :replay} = recovery} = subscriber
       )
       when recovery.cursor < recovery.head.revision do
    case Stateholder.recovery_page(
           subscriber.identity.session,
           recovery.cursor,
           recovery.head.revision
         ) do
      {:ok, [_ | _] = events} ->
        case ProtocolV2.recovery_page(events, recovery.id) do
          {:ok, encoded, last_revision} ->
            next = %{
              subscriber
              | recovery: %{recovery | cursor: last_revision, queued_kind: :page}
            }

            last = List.last(events)

            acknowledgement = %{
              recovery_id: recovery.id,
              revision: last_revision,
              state_digest: last |> field(:resulting_state_digest) |> digest_hex(),
              queued_kind: :page,
              transport_in_flight?: false
            }

            reserve_recovery_frame(socket, next, encoded, true, acknowledgement)

          {:error, reason} ->
            {:error, reason}
        end

      {:ok, []} ->
        {:error, :revision_gap}

      {:error, reason} ->
        {:error, reason}

      {:retryable, _reason} ->
        {:error, :dependency_unavailable}
    end
  end

  defp enqueue_next_recovery_frame(socket, subscriber) do
    recovery = subscriber.recovery

    encoded =
      ProtocolV2.recovery_complete(
        %Recovery{mode: recovery.mode, head: recovery.head, snapshot: nil, events: []},
        recovery.id
      )

    next = %{subscriber | recovery: %{recovery | queued_kind: :complete}}
    reserve_recovery_frame(socket, next, encoded, false, nil)
  end

  defp reserve_recovery_frame(socket, subscriber, encoded, replay_page?, acknowledgement) do
    options =
      [replay_page?: replay_page?]
      |> Keyword.put(:revision, acknowledgement && acknowledgement.revision)
      |> Keyword.put(:state_digest, acknowledgement && acknowledgement.state_digest)

    case OutboundQueue.push(subscriber.queue, encoded, options) do
      :ok ->
        send(socket, {:sync_outbound_ready, self()})
        recovery = %{subscriber.recovery | expected_ack: acknowledgement}
        {:ok, %{subscriber | recovery: recovery, notified?: true}}

      {:error, {:overflow, reason}} ->
        {:error, reason}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp acknowledge_recovery_frame(
         state,
         socket,
         %{recovery: %{expected_ack: expected}} = subscriber,
         recovery_id,
         revision,
         state_digest
       )
       when is_map(expected) do
    exact? =
      expected.transport_in_flight? and expected.recovery_id == recovery_id and
        expected.revision == revision and expected.state_digest == state_digest and
        expected.queued_kind == subscriber.recovery.queued_kind

    if exact? do
      release_recovery_frame(state, socket, subscriber, revision, state_digest)
    else
      fail_recovery_ack(state, socket, subscriber, :invalid_recovery_ack)
    end
  end

  defp acknowledge_recovery_frame(
         state,
         socket,
         subscriber,
         _recovery_id,
         _revision,
         _state_digest
       ),
       do: fail_recovery_ack(state, socket, subscriber, :invalid_recovery_ack)

  defp release_recovery_frame(state, socket, subscriber, revision, state_digest) do
    case OutboundQueue.ack_recovery(subscriber.queue, revision, state_digest) do
      {:ok, _stats} ->
        recovery = %{subscriber.recovery | expected_ack: nil}
        acknowledged = %{subscriber | recovery: recovery}

        case enqueue_next_recovery_frame(socket, acknowledged) do
          {:ok, next_subscriber} ->
            {:reply, :ok, %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}

          {:error, reason} ->
            fail_recovery_ack(state, socket, subscriber, reason)
        end

      {:error, reason} ->
        fail_recovery_ack(state, socket, subscriber, reason)
    end
  end

  defp fail_recovery_ack(state, socket, subscriber, reason) do
    notify_reconnect(socket, reason, subscriber.acknowledged_revision)
    {:reply, {:error, reason}, remove_socket(state, socket)}
  end

  defp pop_socket(state, socket, subscriber) do
    case OutboundQueue.pop(subscriber.queue) do
      {:ok, entry} ->
        popped_entry(state, socket, subscriber, entry)

      :empty ->
        next = %{subscriber | notified?: false}
        {:reply, :empty, %{state | sockets: Map.put(state.sockets, socket, next)}}

      {:error, _reason} ->
        next = remove_socket(state, socket)
        {:reply, {:error, :queue_unavailable}, next}
    end
  end

  defp popped_entry(
         state,
         socket,
         %{terminal_revision: revision},
         %{revision: revision, encoded: encoded}
       )
       when is_integer(revision) do
    {:reply, {:ok, encoded, true}, remove_socket(state, socket)}
  end

  defp popped_entry(state, socket, subscriber, entry) do
    more? = not unsent_empty?(subscriber.queue)
    next_subscriber = %{subscriber | notified?: more?}
    if more?, do: send(socket, {:sync_outbound_ready, self()})

    {:reply, {:ok, entry.encoded, false},
     %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}}
  end

  defp acknowledge_socket(state, socket, subscriber, revision, state_digest) do
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

  defp acknowledge_current(state, %{acknowledged_digest: digest}, digest),
    do: {:reply, :ok, state}

  defp acknowledge_current(state, _subscriber, _digest),
    do: {:reply, {:error, :digest_mismatch}, state}

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
    {:reply, :ok, remove_socket(next, socket)}
  end

  defp acknowledged_result(
         {:ok, _stats},
         state,
         socket,
         subscriber,
         revision,
         state_digest
       ) do
    if subscriber.enqueued_revision < state.target_revision, do: send(self(), :repair_now)
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
    notify_reconnect(socket, reason, subscriber.acknowledged_revision)
    {:reply, {:error, reason}, remove_socket(state, socket)}
  end

  defp acknowledged_result(
         {:error, reason},
         state,
         _socket,
         _subscriber,
         _revision,
         _state_digest
       ),
       do: {:reply, {:error, reason}, state}

  defp store_ack(state, socket, subscriber, revision, state_digest) do
    next_subscriber = %{
      subscriber
      | acknowledged_revision: revision,
        acknowledged_digest: state_digest
    }

    %{state | sockets: Map.put(state.sockets, socket, next_subscriber)}
  end

  defp check_queue_ages(state) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn {socket, subscriber}, kept ->
        case OutboundQueue.stats(subscriber.queue) do
          {:ok, _stats} ->
            Map.put(kept, socket, subscriber)

          {:error, {:overflow, reason}} ->
            notify_reconnect(socket, reason, subscriber.acknowledged_revision)
            close_subscriber(subscriber)
            kept

          {:error, _reason} ->
            notify_reconnect(
              socket,
              :queue_unavailable,
              subscriber.acknowledged_revision
            )

            close_subscriber(subscriber)
            kept
        end
      end)

    %{state | sockets: sockets}
  end

  defp drain_sockets(state) do
    sockets =
      Enum.reduce(state.sockets, %{}, fn socket_entry, kept ->
        drain_socket(socket_entry, kept)
      end)

    %{state | sockets: sockets}
  end

  defp drain_socket({socket, subscriber}, kept) do
    if outstanding_empty?(subscriber.queue) do
      send(socket, {:sync_server_drained, self()})
      close_subscriber(subscriber)
      kept
    else
      retain_draining_socket(socket, subscriber, kept)
    end
  end

  defp retain_draining_socket(socket, subscriber, kept) do
    unsent? = not unsent_empty?(subscriber.queue)
    notify? = not subscriber.notified? and unsent?
    if notify?, do: send(socket, {:sync_outbound_ready, self()})

    Map.put(kept, socket, %{
      subscriber
      | draining?: true,
        notified?: subscriber.notified? or unsent?
    })
  end

  defp reconnect_all(state, reason) do
    Enum.each(state.sockets, fn {socket, subscriber} ->
      notify_reconnect(socket, reason, subscriber.acknowledged_revision)
      close_subscriber(subscriber)
    end)

    %{state | sockets: %{}}
  end

  defp remove_socket(state, socket) do
    case Map.pop(state.sockets, socket) do
      {nil, _sockets} ->
        state

      {subscriber, sockets} ->
        close_subscriber(subscriber)
        %{state | sockets: sockets}
    end
  end

  defp close_subscriber(subscriber) do
    Process.demonitor(subscriber.monitor, [:flush])

    case OutboundQueue.close(subscriber.queue) do
      {:ok, _stats} -> :ok
      {:error, _reason} -> :ok
    end
  end

  defp stop_if_empty(state) do
    if map_size(state.sockets) == 0,
      do: {:stop, :normal, state},
      else: {:noreply, state}
  end

  defp unsent_empty?(queue) do
    case OutboundQueue.unsent?(queue) do
      {:ok, false} -> true
      _other -> false
    end
  end

  defp outstanding_empty?(queue) do
    case OutboundQueue.outstanding?(queue) do
      {:ok, false} -> true
      _other -> false
    end
  end

  defp encode_event(event) do
    {:ok, ProtocolV2.event(event)}
  rescue
    ArgumentError -> {:error, :invalid_event}
  end

  defp compatible_head?(nil, _head), do: true

  defp compatible_head?(current, head) do
    current.revision != head.revision or current.digest == head.digest
  end

  defp older_head(nil, head), do: head
  defp older_head(current, head) when head.revision < current.revision, do: head
  defp older_head(current, _head), do: current

  defp head_from_event(event) do
    %{
      revision: field(event, :revision),
      state_schema_version: field(event, :schema_version),
      digest: field(event, :resulting_state_digest)
    }
  end

  defp digest_hex(<<_digest::binary-size(32)>> = digest),
    do: Base.encode16(digest, case: :lower)

  defp digest_hex(<<digest::binary-size(64)>>), do: String.downcase(digest)

  defp notify_reconnect(socket, reason, revision),
    do: send(socket, {:sync_outbound_overflow, reason, revision})

  defp field(map, key), do: Map.get(map, key, Map.get(map, Atom.to_string(key)))

  defp via(session),
    do: {:via, Registry, {ChalkSync.Sessions.Registry, SessionKey.authority_key(session)}}
end
