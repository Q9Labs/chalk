defmodule ChalkSync.WhiteboardV1.Authority do
  @moduledoc """
  Whether a live whiteboard socket may keep exchanging frames.

  Fanout delivers each change to every socket in the Episode, so the Episode's lifecycle states
  are read at most once a second per node and shared by all of its sockets. The first socket that
  needs a read does it in its own process; the others wait for that result. This process only
  coordinates the reads and owns the cache, so one slow Episode never delays another.
  """

  use GenServer

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Repository

  @table __MODULE__
  @ttl_ms 1_000
  @sweep_ms 30_000
  # The read itself times out after a second; this also covers the wait for a pool connection.
  # A read older than this is taken over by the next socket.
  @wait_ms 5_000

  @type access :: :ok | {:error, :permission_denied} | {:retryable, {atom(), String.t()}}

  def start_link(_options), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @spec ttl_ms() :: non_neg_integer()
  def ttl_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_ttl_ms, @ttl_ms)

  @spec wait_ms() :: pos_integer()
  def wait_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_wait_ms, @wait_ms)

  @spec check(Identity.t()) :: access()
  def check(%Identity{} = identity) do
    case fresh(identity.episode, System.monotonic_time(:millisecond)) do
      {:ok, access} -> decide(access, identity)
      :stale -> identity.episode |> await_refresh() |> resolve(identity)
    end
  end

  defp await_refresh(episode) do
    case GenServer.call(__MODULE__, {:refresh, episode}, wait_ms()) do
      {:read, read} ->
        read_at = System.monotonic_time(:millisecond)
        result = Repository.episode_access(episode)
        GenServer.cast(__MODULE__, {:read, episode, read, read_at, result})
        result

      {:done, result} ->
        result
    end
  catch
    :exit, _reason -> {:retryable, {:storage_unavailable, "exit"}}
  end

  defp resolve({:ok, access}, identity), do: decide(access, identity)
  defp resolve({:error, :not_found}, _identity), do: {:error, :permission_denied}
  defp resolve({:retryable, _reason} = unavailable, _identity), do: unavailable

  defp fresh(episode, now_ms) do
    ttl_ms = ttl_ms()

    case :ets.lookup(@table, episode) do
      [{^episode, read_at, access}] when now_ms - read_at < ttl_ms -> {:ok, access}
      _missing_or_expired -> :stale
    end
  rescue
    # The table goes away with Authority while it restarts; the call then fails as retryable.
    ArgumentError -> :stale
  end

  # Removing a Participant or ending an Episode passes through leaving or ending, and a failed
  # provider operation restores active. Only the final states close the socket.
  defp decide(%{status: episode_status, participants: participants}, identity) do
    key = {String.downcase(identity.participant_id), identity.participant_generation}

    case {episode_status, Map.get(participants, key)} do
      {"ended", _status} -> {:error, :permission_denied}
      {_episode, nil} -> {:error, :permission_denied}
      {_episode, "left"} -> {:error, :permission_denied}
      {_episode, _reversible_or_active} -> :ok
    end
  end

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :protected, read_concurrency: true])
    {:ok, %{reads: %{}, sweep: schedule_sweep()}}
  end

  @impl true
  def handle_call({:refresh, episode}, {caller, _tag} = from, state) do
    now_ms = System.monotonic_time(:millisecond)
    stalled_before = now_ms - wait_ms()

    case {Map.get(state.reads, episode), fresh(episode, now_ms)} do
      {%{started_at: started_at}, _cached} when started_at > stalled_before ->
        {:noreply, update_in(state.reads[episode].waiters, &[from | &1])}

      # A read finished between the caller's lookup and this call.
      {nil, {:ok, access}} ->
        {:reply, {:done, {:ok, access}}, state}

      # No read, or one that stalled: this caller reads, and any waiters get its result.
      {stalled, _cached} ->
        read = %{reader: Process.monitor(caller), started_at: now_ms, waiters: abandon(stalled)}
        {:reply, {:read, read.reader}, put_in(state.reads[episode], read)}
    end
  end

  @impl true
  def handle_cast({:read, episode, reader, read_at, result}, state) do
    case Map.get(state.reads, episode) do
      %{reader: ^reader} = read ->
        Process.demonitor(reader, [:flush])
        with {:ok, access} <- result, do: :ets.insert(@table, {episode, read_at, access})
        Enum.each(read.waiters, &GenServer.reply(&1, {:done, result}))
        {:noreply, %{state | reads: Map.delete(state.reads, episode)}}

      # The read was taken over, or it started before this process restarted.
      _replaced_or_unknown ->
        {:noreply, state}
    end
  end

  @impl true
  def handle_info({:DOWN, reader, :process, _pid, _reason}, state) do
    case Enum.find(state.reads, fn {_episode, read} -> read.reader == reader end) do
      nil -> {:noreply, state}
      {episode, read} -> {:noreply, %{state | reads: hand_over(state.reads, episode, read)}}
    end
  end

  def handle_info(:sweep, state) do
    Process.cancel_timer(state.sweep)
    expired = System.monotonic_time(:millisecond) - ttl_ms()
    :ets.select_delete(@table, [{{:_, :"$1", :_}, [{:"=<", :"$1", expired}], [true]}])
    {:noreply, %{state | sweep: schedule_sweep()}}
  end

  defp abandon(nil), do: []

  defp abandon(stalled) do
    Process.demonitor(stalled.reader, [:flush])
    stalled.waiters
  end

  # The reader died before it reported, so the longest waiter reads instead.
  defp hand_over(reads, episode, %{waiters: []}), do: Map.delete(reads, episode)

  defp hand_over(reads, episode, %{waiters: waiters}) do
    [{next, _tag} = from | rest] = Enum.reverse(waiters)
    reader = Process.monitor(next)
    GenServer.reply(from, {:read, reader})

    Map.put(reads, episode, %{
      reader: reader,
      started_at: System.monotonic_time(:millisecond),
      waiters: Enum.reverse(rest)
    })
  end

  defp schedule_sweep do
    Process.send_after(
      self(),
      :sweep,
      Application.get_env(:chalk_sync, :whiteboard_authority_sweep_ms, @sweep_ms)
    )
  end
end
