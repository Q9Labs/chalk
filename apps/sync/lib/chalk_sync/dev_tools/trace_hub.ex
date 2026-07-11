defmodule ChalkSync.DevTools.TraceHub do
  @moduledoc false

  use GenServer

  @history_size 500

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def record(source, action, details \\ %{}) do
    if Process.whereis(__MODULE__) do
      GenServer.cast(__MODULE__, {:record, source, action, details})
    end

    :ok
  end

  def subscribe(subscriber \\ self()) do
    GenServer.call(__MODULE__, {:subscribe, subscriber})
  end

  @impl true
  def init(_opts) do
    {:ok, %{events: :queue.new(), next_id: 1, subscribers: %{}}}
  end

  @impl true
  def handle_call({:subscribe, subscriber}, _from, state) do
    monitor_ref = Process.monitor(subscriber)
    send(subscriber, {:trace_history, :queue.to_list(state.events)})

    {:reply, :ok, put_in(state.subscribers[monitor_ref], subscriber)}
  end

  @impl true
  def handle_cast({:record, source, action, details}, state) do
    event = %{
      "id" => state.next_id,
      "timestamp" => System.system_time(:millisecond),
      "source" => source,
      "action" => action,
      "details" => details
    }

    Enum.each(state.subscribers, fn {_ref, subscriber} ->
      send(subscriber, {:trace_event, event})
    end)

    events = event |> :queue.in(state.events) |> trim_history()
    {:noreply, %{state | events: events, next_id: state.next_id + 1}}
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    {:noreply, %{state | subscribers: Map.delete(state.subscribers, ref)}}
  end

  defp trim_history(events) do
    if :queue.len(events) > @history_size do
      {_removed, events} = :queue.out(events)
      events
    else
      events
    end
  end
end
