defmodule ChalkSync.WhiteboardV1.ViewClock do
  @moduledoc false
  use GenServer

  # A full clock refuses new Episodes rather than forgetting an ordering watermark.
  @capacity 4096

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  def advance(episode, observed, leading?, server \\ __MODULE__) do
    GenServer.call(server, {:advance, episode, observed, leading?})
  end

  @impl true
  def init(options) do
    {:ok,
     %{
       times: %{},
       capacity: Keyword.get(options, :capacity, @capacity),
       wall: Keyword.get(options, :wall, fn -> System.system_time(:microsecond) end)
     }}
  end

  @impl true
  def handle_call({:advance, episode, observed, leading?}, _from, state) do
    key = {episode.tenant_id, episode.episode_id}

    if map_size(state.times) < state.capacity or Map.has_key?(state.times, key) do
      high = max(Map.get(state.times, key, 0), observed)
      next = if leading?, do: max(state.wall.(), high) + 1, else: high
      {:reply, {:ok, next}, %{state | times: Map.put(state.times, key, next)}}
    else
      {:reply, {:error, :view_clock_capacity}, state}
    end
  end
end
