defmodule ChalkSync.WhiteboardV1.Authority.Poller do
  @moduledoc false
  # One per Episode per node. It stops when its last socket exits, and Authority then drops its read.

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
          case DynamicSupervisor.start_child(Authority.Pollers, {__MODULE__, episode}) do
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
    Authority.own(self())

    # No read has succeeded yet, so read_at stays nil and a failed read cannot make access fresh.
    {:ok, %{episode: episode, sockets: MapSet.new(), access: nil, read_at: nil},
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

  @impl true
  def handle_info(:read, state), do: {:noreply, read(state)}

  def handle_info({:DOWN, _monitor, :process, socket, _reason}, state) do
    sockets = MapSet.delete(state.sockets, socket)

    if MapSet.size(sockets) == 0,
      do: {:stop, :normal, %{state | sockets: sockets}},
      else: {:noreply, %{state | sockets: sockets}}
  end

  # A failed read keeps the last good access and its start, so sockets close once that is stale.
  # Reads start at a fixed rate: the next one is due one interval after this one started, so a
  # slow read does not push the next one out.
  defp read(state) do
    started_at = now_ms()
    Process.send_after(self(), :read, started_at + Authority.poll_ms(), abs: true)

    case read_access(state.episode) do
      {:ok, access} -> store(%{state | access: access, read_at: started_at}, nil)
      {:error, :not_found} -> store(%{state | access: :not_found, read_at: started_at}, nil)
      {:retryable, {_reason, failure}} -> store(state, failure)
    end
  end

  @doc false
  # The deadline covers the whole read, with pool checkout, preparation and retries, because a
  # query timeout alone restarts on a retry.
  def read_access(episode) do
    task =
      Task.Supervisor.async_nolink(ChalkSync.CommandTaskSupervisor, fn ->
        Repository.episode_access(episode)
      end)

    case Task.yield(task, Authority.read_ms()) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} -> result
      {:exit, _reason} -> {:retryable, {:storage_unavailable, "exit"}}
      nil -> {:retryable, {:storage_unavailable, "deadline"}}
    end
  end

  defp store(state, failure) do
    Authority.store(state.episode, state.access, state.read_at, failure)
    state
  end

  # UUIDs in tokens may differ in letter case, so one Episode has one poller whatever the case.
  defp key(episode), do: {:whiteboard_authority, EpisodeKey.authority_key(episode)}
  defp now_ms, do: System.monotonic_time(:millisecond)
end
