defmodule ChalkSync.Stateholder.Memory do
  @moduledoc """
  ETS-backed stateholder adapter for single-node dev and test.

  All writes serialize through this GenServer so compare-and-set commits are
  atomic even if a second (buggy) writer appears. Reads go straight to ETS.
  """

  @behaviour ChalkSync.Stateholder

  use GenServer

  @rooms __MODULE__.Rooms
  @events __MODULE__.Events
  @retained_events 500

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl ChalkSync.Stateholder
  def load(room_id) do
    case :ets.lookup(@rooms, room_id) do
      [{^room_id, state}] -> {:ok, state}
      [] -> :not_found
    end
  end

  @impl ChalkSync.Stateholder
  def commit(room_id, expected_revision, event, state) do
    GenServer.call(__MODULE__, {:commit, room_id, expected_revision, event, state})
  end

  @impl ChalkSync.Stateholder
  def events_since(room_id, cursor) do
    case :ets.lookup(@events, room_id) do
      [] when cursor == 0 ->
        {:ok, []}

      [] ->
        {:error, :cursor_unavailable}

      [{^room_id, newest_first}] ->
        oldest_retained = List.last(newest_first).base_revision

        if cursor < oldest_retained do
          {:error, :cursor_unavailable}
        else
          {:ok, newest_first |> Enum.take_while(&(&1.revision > cursor)) |> Enum.reverse()}
        end
    end
  end

  @doc "Test helper: drops all rooms and events."
  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  @impl GenServer
  def init(_opts) do
    :ets.new(@rooms, [:named_table, :protected, read_concurrency: true])
    :ets.new(@events, [:named_table, :protected, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:commit, room_id, expected_revision, event, state}, _from, s) do
    current_revision =
      case :ets.lookup(@rooms, room_id) do
        [{^room_id, current}] -> current.revision
        [] -> 0
      end

    if current_revision == expected_revision do
      :ets.insert(@rooms, {room_id, state})
      append_event(room_id, event)
      {:reply, :ok, s}
    else
      {:reply, {:error, {:revision_conflict, current_revision}}, s}
    end
  end

  def handle_call(:reset, _from, s) do
    :ets.delete_all_objects(@rooms)
    :ets.delete_all_objects(@events)
    {:reply, :ok, s}
  end

  defp append_event(room_id, event) do
    newest_first =
      case :ets.lookup(@events, room_id) do
        [{^room_id, events}] -> events
        [] -> []
      end

    :ets.insert(@events, {room_id, Enum.take([event | newest_first], @retained_events)})
  end
end
