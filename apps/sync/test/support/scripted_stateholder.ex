defmodule ChalkSync.ScriptedStateholder do
  @moduledoc """
  Deterministic stateholder used by the sync breaker.

  Faults are armed per operation and consumed in FIFO order. Blocking faults
  report their exact checkpoint to the controller and wait for a matching
  `release/2`, which lets tests kill or inspect the calling room writer at the
  commit boundary without timing sleeps.
  """

  @behaviour ChalkSync.Stateholder

  use GenServer

  @retained_events 500
  @operations [:load, :commit, :events_since]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def arm(operation, fault) when operation in @operations do
    GenServer.call(__MODULE__, {:arm, operation, fault})
  end

  def release(server_pid, tag) do
    send(server_pid, {:sync_breaker_release, tag})
    :ok
  end

  def reset, do: GenServer.call(__MODULE__, :reset)

  @impl ChalkSync.Stateholder
  def load(room_id), do: GenServer.call(__MODULE__, {:load, room_id})

  @impl ChalkSync.Stateholder
  def commit(room_id, expected_revision, event, state) do
    GenServer.call(__MODULE__, {:commit, room_id, expected_revision, event, state})
  end

  @impl ChalkSync.Stateholder
  def events_since(room_id, cursor) do
    GenServer.call(__MODULE__, {:events_since, room_id, cursor})
  end

  @impl ChalkSync.Stateholder
  def decide_command(_identity, _command), do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def resolve_receipt(_identity, _command), do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def recover(_session, _cursor), do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def recover_session(session, cursor), do: recover(session, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(_session, _after_revision, _through_revision),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(_session, _intent_id),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(_session, _intent_id, _reason), do: :ok

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(_limit), do: {:ok, []}

  @impl GenServer
  def init(_opts) do
    {:ok, initial_state()}
  end

  @impl GenServer
  def handle_call({:arm, operation, fault}, _from, state) do
    faults = Map.update!(state.faults, operation, &:queue.in(fault, &1))
    {:reply, :ok, %{state | faults: faults}}
  end

  def handle_call(:reset, _from, _state) do
    {:reply, :ok, initial_state()}
  end

  def handle_call({:load, room_id}, from, state) do
    {fault, state} = take_fault(state, :load)
    await_before_fault(fault, :load, from)

    reply =
      case state.rooms do
        %{^room_id => room} -> {:ok, room}
        _ -> :not_found
      end

    await_after_fault(fault, :load, from)
    {:reply, reply, state}
  end

  def handle_call({:commit, room_id, expected_revision, event, room}, from, state) do
    {fault, state} = take_fault(state, :commit)
    await_before_fault(fault, :commit, from)

    current_revision =
      case state.rooms do
        %{^room_id => current} -> current.revision
        _ -> 0
      end

    cond do
      fault == :revision_conflict ->
        {:reply, {:error, {:revision_conflict, current_revision}}, state}

      current_revision != expected_revision ->
        {:reply, {:error, {:revision_conflict, current_revision}}, state}

      true ->
        state = commit_room(state, room_id, event, room)
        await_after_fault(fault, :commit, from)
        {:reply, :ok, state}
    end
  end

  def handle_call({:events_since, room_id, cursor}, from, state) do
    {fault, state} = take_fault(state, :events_since)
    await_before_fault(fault, :events_since, from)
    reply = events_since(state, room_id, cursor)
    await_after_fault(fault, :events_since, from)
    {:reply, reply, state}
  end

  defp initial_state do
    %{
      rooms: %{},
      events: %{},
      faults: Map.new(@operations, &{&1, :queue.new()})
    }
  end

  defp take_fault(state, operation) do
    case :queue.out(state.faults[operation]) do
      {{:value, fault}, remaining} -> {fault, put_in(state.faults[operation], remaining)}
      {:empty, _queue} -> {nil, state}
    end
  end

  defp await_before_fault({:block_before, controller, tag}, operation, from) do
    await_release(controller, tag, operation, :before, from)
  end

  defp await_before_fault(_fault, _operation, _from), do: :ok

  defp await_after_fault({:block_after, controller, tag}, operation, from) do
    await_release(controller, tag, operation, :after, from)
  end

  defp await_after_fault(_fault, _operation, _from), do: :ok

  defp await_release(controller, tag, operation, position, {caller, _call_tag}) do
    send(controller, {:sync_breaker_checkpoint, tag, operation, position, self(), caller})

    receive do
      {:sync_breaker_release, ^tag} -> :ok
    end
  end

  defp commit_room(state, room_id, event, room) do
    events = Map.get(state.events, room_id, [])
    events = Enum.take([event | events], @retained_events)

    %{
      state
      | rooms: Map.put(state.rooms, room_id, room),
        events: Map.put(state.events, room_id, events)
    }
  end

  defp events_since(state, room_id, cursor) do
    case Map.get(state.events, room_id, []) do
      [] when cursor == 0 ->
        {:ok, []}

      [] ->
        {:error, :cursor_unavailable}

      newest_first ->
        oldest_retained = List.last(newest_first).base_revision

        if cursor < oldest_retained do
          {:error, :cursor_unavailable}
        else
          {:ok, newest_first |> Enum.take_while(&(&1.revision > cursor)) |> Enum.reverse()}
        end
    end
  end
end
