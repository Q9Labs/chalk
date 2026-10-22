defmodule ChalkSync.WhiteboardV1.Authority.Poller do
  @moduledoc false
  # One per Episode per node. It stops, and forgets the Episode, when its last socket exits.

  use GenServer, restart: :temporary

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.WhiteboardV1.Authority
  alias ChalkSync.WhiteboardV1.Repository

  def watch(episode, socket) do
    poller =
      case Registry.lookup(ChalkSync.Episodes.Registry, key(episode)) do
        [{poller, _value}] ->
          poller

        [] ->
          case DynamicSupervisor.start_child(ChalkSync.Episodes.Supervisor, {__MODULE__, episode}) do
            {:ok, poller} -> poller
            {:error, {:already_started, poller}} -> poller
          end
      end

    # A poller that is stopping drops this; the socket's next check finds no entry and watches again.
    GenServer.cast(poller, {:watch, socket})
  end

  def start_link(episode) do
    GenServer.start_link(__MODULE__, episode,
      name: {:via, Registry, {ChalkSync.Episodes.Registry, key(episode)}}
    )
  end

  @impl true
  def init(episode) do
    {:ok, %{episode: episode, sockets: MapSet.new(), access: nil, read_at: now_ms()},
     {:continue, :read}}
  end

  @impl true
  def handle_continue(:read, state), do: {:noreply, read(state)}

  @impl true
  def handle_cast({:watch, socket}, state) do
    if MapSet.member?(state.sockets, socket) do
      {:noreply, state}
    else
      Process.monitor(socket)
      {:noreply, %{state | sockets: MapSet.put(state.sockets, socket)}}
    end
  end

  # Coordinator.drain_all/0 casts :drain to every child of the Episode supervisor. A poller keeps
  # reading until its last socket closes, so it ignores the drain.
  def handle_cast(:drain, state), do: {:noreply, state}

  @impl true
  def handle_info(:read, state), do: {:noreply, read(state)}

  def handle_info({:DOWN, _monitor, :process, socket, _reason}, state) do
    sockets = MapSet.delete(state.sockets, socket)

    if MapSet.size(sockets) == 0,
      do: {:stop, :normal, %{state | sockets: sockets}},
      else: {:noreply, %{state | sockets: sockets}}
  end

  @impl true
  def terminate(_reason, state), do: Authority.forget(state.episode)

  # A failed read keeps the last good access and its time, so sockets close only once it is stale.
  defp read(state) do
    started_at = now_ms()

    state =
      case Repository.episode_access(state.episode) do
        {:ok, access} -> store(%{state | access: access, read_at: started_at}, nil)
        {:error, :not_found} -> store(%{state | access: :not_found, read_at: started_at}, nil)
        {:retryable, {_reason, failure}} -> store(state, failure)
      end

    Process.send_after(self(), :read, Authority.poll_ms())
    state
  end

  defp store(state, failure) do
    Authority.store(state.episode, state.access, state.read_at, failure)
    state
  end

  # UUIDs in tokens may differ in letter case, so one Episode has one poller whatever the case.
  defp key(episode), do: {:whiteboard_authority, EpisodeKey.authority_key(episode)}
  defp now_ms, do: System.monotonic_time(:millisecond)
end
