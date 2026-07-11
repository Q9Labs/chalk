defmodule ChalkSync.Rooms.RoomServer do
  @moduledoc """
  One authoritative writer per room (north-star sync invariant).

  All live-state mutations for a room serialize through this process. Flow per
  command: validate against the pure `Room` core -> compare-and-set commit to
  the stateholder -> only then fan out to subscribers. A revision conflict on
  commit means another writer exists (split-brain); correctness wins, so this
  process stops and clients reconnect + re-snapshot.

  The process is a rebuildable projection: it hydrates from the stateholder on
  start and stops when the last subscriber leaves. Losing it loses nothing.
  """

  use GenServer, restart: :transient

  require Logger

  alias ChalkSync.DevTools.TraceHub
  alias ChalkSync.Rooms.Room
  alias ChalkSync.Stateholder

  @max_remembered_commands 256

  # -- Client API --------------------------------------------------------------

  @doc """
  Joins a participant and subscribes `subscriber` (a socket pid) to room events.

  Returns `{:ok, room_pid, reply}` where `reply` is `%{snapshot: ...}` or,
  when `cursor` is present and retained, `%{replay: events, control_revision:
  n}` — computed inside the writer so it is consistent with subsequent fanout.
  Subscribers should monitor `room_pid` and drop the connection if it dies, so
  clients reconnect and re-snapshot.
  """
  def join(room_id, participant_id, display_name, subscriber, cursor \\ nil) do
    with {:ok, pid} <- ensure_started(room_id) do
      case GenServer.call(pid, {:join, participant_id, display_name, subscriber, cursor}) do
        {:ok, reply} -> {:ok, pid, reply}
        {:error, reason} -> {:error, reason}
      end
    end
  catch
    # The room can stop (last subscriber left) between lookup and call.
    :exit, _ -> {:error, :retry}
  end

  @doc "Returns `{:committed, revision} | {:duplicate, revision} | {:rejected, reason}`."
  def command(room_id, participant_id, command_id, name, payload) do
    case Registry.lookup(ChalkSync.Rooms.Registry, room_id) do
      [{pid, _}] -> GenServer.call(pid, {:command, participant_id, command_id, name, payload})
      [] -> {:rejected, :not_joined}
    end
  catch
    :exit, _ -> {:rejected, :retry}
  end

  def whereis(room_id) do
    case Registry.lookup(ChalkSync.Rooms.Registry, room_id) do
      [{pid, _}] -> pid
      [] -> nil
    end
  end

  defp ensure_started(room_id) do
    spec = {__MODULE__, room_id}

    case DynamicSupervisor.start_child(ChalkSync.Rooms.Supervisor, spec) do
      {:ok, pid} -> {:ok, pid}
      {:error, {:already_started, pid}} -> {:ok, pid}
      {:error, reason} -> {:error, reason}
    end
  end

  def start_link(room_id) do
    GenServer.start_link(__MODULE__, room_id, name: via(room_id))
  end

  defp via(room_id), do: {:via, Registry, {ChalkSync.Rooms.Registry, room_id}}

  # -- Server ------------------------------------------------------------------

  @impl true
  def init(room_id) do
    room =
      case Stateholder.load(room_id) do
        {:ok, room} -> room
        :not_found -> Room.new(room_id)
      end

    TraceHub.record("room", "writer_started", %{
      "revision" => room.revision,
      "room_id" => room_id
    })

    {:ok,
     %{
       room: room,
       # subscriber pid => %{participant_id, monitor_ref}
       subscribers: %{},
       # {participant_id, command_id} => result, bounded FIFO
       remembered: %{},
       remembered_order: :queue.new()
     }}
  end

  @impl true
  def handle_call({:join, participant_id, display_name, subscriber, cursor}, _from, state) do
    case admit(state, participant_id, display_name) do
      {:ok, state} ->
        ref = Process.monitor(subscriber)
        subscriber_info = %{participant_id: participant_id, monitor_ref: ref}
        state = put_in(state.subscribers[subscriber], subscriber_info)

        TraceHub.record("room", "subscriber_added", %{
          "participant_id" => participant_id,
          "room_id" => state.room.id,
          "subscribers" => map_size(state.subscribers)
        })

        {:reply, {:ok, join_reply(state.room, cursor)}, state}

      {:error, reason} ->
        {:stop, reason, {:error, reason}, state}
    end
  end

  def handle_call({:command, participant_id, command_id, name, payload}, _from, state) do
    key = {participant_id, command_id}

    case state.remembered do
      %{^key => result} ->
        {:reply, duplicate_of(result), state}

      _ ->
        {result, state} = execute(state, participant_id, name, payload)

        case result do
          {:split_brain, current} ->
            Logger.error("room #{state.room.id}: revision conflict (current=#{current})")
            {:stop, :revision_conflict, {:rejected, :retry}, state}

          _ ->
            {:reply, result, remember(state, key, result)}
        end
    end
  end

  @impl true
  def handle_info({:DOWN, _ref, :process, pid, _reason}, state) do
    {info, state} = pop_in(state.subscribers[pid])

    state =
      if info && last_subscription?(state, info.participant_id) do
        case execute(state, info.participant_id, :leave, %{}) do
          {{:split_brain, _current}, state} -> state
          {_result, state} -> state
        end
      else
        state
      end

    if map_size(state.subscribers) == 0 do
      TraceHub.record("room", "writer_stopped", %{
        "reason" => "room_empty",
        "revision" => state.room.revision,
        "room_id" => state.room.id
      })

      {:stop, :normal, state}
    else
      {:noreply, state}
    end
  end

  # -- Internals ---------------------------------------------------------------

  defp admit(state, participant_id, display_name) do
    if Room.joined?(state.room, participant_id) do
      # Reconnect: the participant is already in room state; no join event.
      {:ok, state}
    else
      case execute(state, participant_id, :join, %{display_name: display_name}) do
        {{:committed, _revision}, state} -> {:ok, state}
        {{:rejected, reason}, _state} -> {:error, reason}
        {{:split_brain, _current}, _state} -> {:error, :revision_conflict}
      end
    end
  end

  defp execute(state, participant_id, command, payload) do
    case Room.apply_command(state.room, participant_id, command, payload) do
      {:ok, event, room} ->
        case Stateholder.commit(room.id, event.base_revision, event, room) do
          :ok ->
            broadcast(state, event)

            TraceHub.record("room", "event_committed", %{
              "event" => event.name,
              "revision" => event.revision,
              "room_id" => room.id
            })

            {{:committed, event.revision}, %{state | room: room}}

          {:error, {:revision_conflict, current}} ->
            {{:split_brain, current}, state}
        end

      {:error, reason} ->
        {{:rejected, reason}, state}
    end
  end

  defp broadcast(state, event) do
    Enum.each(state.subscribers, fn {pid, _info} -> send(pid, {:sync_event, event}) end)
  end

  defp join_reply(room, cursor) do
    snapshot = Room.snapshot(room)

    with true <- is_integer(cursor) and cursor >= 0 and cursor <= room.revision,
         {:ok, events} <- Stateholder.events_since(room.id, cursor) do
      %{replay: events, control_revision: room.revision, snapshot: nil}
    else
      _ -> %{replay: nil, control_revision: room.revision, snapshot: snapshot}
    end
  end

  defp last_subscription?(state, participant_id) do
    not Enum.any?(state.subscribers, fn {_pid, info} ->
      info.participant_id == participant_id
    end)
  end

  defp duplicate_of({:committed, revision}), do: {:duplicate, revision}
  defp duplicate_of(other), do: other

  defp remember(state, key, result) do
    order = :queue.in(key, state.remembered_order)
    remembered = Map.put(state.remembered, key, result)

    if map_size(remembered) > @max_remembered_commands do
      {{:value, oldest}, order} = :queue.out(order)
      %{state | remembered: Map.delete(remembered, oldest), remembered_order: order}
    else
      %{state | remembered: remembered, remembered_order: order}
    end
  end
end
