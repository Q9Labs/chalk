defmodule ChalkSync.WhiteboardV1.Authority do
  @moduledoc """
  Whether a live whiteboard socket may keep exchanging frames.

  While any whiteboard socket of an Episode is live on this node, one `Authority.Poller` starts a
  read of the Episode's lifecycle states every second and stores the result here. Sockets only look
  up the stored result, on every frame and on a one-second tick, so a large call costs one database
  read per second per node whether its boards are busy or idle.

  Access is fresh only within the stale limit of a successful database read: the start of the
  stored read that last succeeded, or the socket's own connect check. A failed read, a new poller
  or a restart never renews it. Each stored read names the poller that wrote it, and this process
  drops that poller's reads when it exits, so a socket whose poller died closes on its next check
  unless a newer read succeeded. This process and the pollers restart together.

  The bounds that follow, with P the poll interval and D the read deadline: once a removal or an
  end is final, the next read starts within P and finishes within D, so frames pass for at most
  P + D. When reads fail, frames pass until the stale limit after the last good read started.
  """

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Authority.Poller

  @table __MODULE__
  @poll_ms 1_000
  @read_ms 1_000
  # A hello or a check waits at most this long for this process to find or start the poller.
  @watch_ms 1_000
  # Without a successful read for this long, sockets close so their clients reconnect.
  @stale_ms 3_000

  # Why a socket lost access, kept in its close trace while the peer sees only a policy violation.
  @type denial :: :episode_not_found | :episode_ended | :participant_inactive
  @type access ::
          :ok | {:error, {:permission_denied, denial()}} | {:retryable, {atom(), String.t()}}

  def start_link(_options), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, read_concurrency: true])
    {:ok, nil}
  end

  @spec poll_ms() :: pos_integer()
  def poll_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_poll_ms, @poll_ms)

  @spec read_ms() :: pos_integer()
  def read_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_read_ms, @read_ms)

  @doc """
  Keeps the Episode's access current while the calling socket is alive. Every watch goes through
  this process, so no socket goes live while it is down, even when the Episode's poller still runs.
  """
  @spec watch(EpisodeKey.t()) :: :ok | {:error, :authority_unavailable}
  def watch(%EpisodeKey{} = episode) do
    GenServer.call(__MODULE__, {:watch, episode, self()}, @watch_ms)
  catch
    :exit, _reason -> {:error, :authority_unavailable}
  end

  @impl true
  def handle_call({:watch, episode, socket}, _from, state) do
    reply =
      case Poller.find_or_start(episode) do
        {:started, poller} ->
          # Only this process starts pollers, so each one is monitored once, from its start.
          Process.monitor(poller)
          Poller.watch(poller, socket)

        {:found, poller} ->
          Poller.watch(poller, socket)

        {:error, :authority_unavailable} = error ->
          error
      end

    {:reply, reply, state}
  end

  @impl true
  def handle_info({:DOWN, _monitor, :process, poller, _reason}, state) do
    :ets.match_delete(@table, {:_, poller, :_, :_, :_})
    {:noreply, state}
  end

  @doc """
  The socket's access from the latest stored read. `connected_at` is when the socket's own connect
  check passed: a read that started no later can predate the Participant's join, so it never denies.
  """
  @spec check(Identity.t(), integer() | nil) :: access()
  def check(%Identity{} = identity, connected_at \\ nil) do
    case lookup(identity.episode) do
      # No poller is reading this Episode yet, so only the connect check counts.
      :missing ->
        case watch(identity.episode) do
          :ok -> freshness(nil, nil, connected_at)
          {:error, :authority_unavailable} -> {:retryable, {:storage_unavailable, "authority"}}
        end

      {:not_found, read_at, _failure}
      when not is_integer(connected_at) or read_at > connected_at ->
        {:error, {:permission_denied, :episode_not_found}}

      {access, read_at, failure} ->
        with :fresh <- freshness(read_at, failure, connected_at), do: decide(access, identity)
    end
  rescue
    # The table goes away with this process while it restarts.
    ArgumentError -> {:retryable, {:storage_unavailable, "authority"}}
  end

  defp lookup(episode) do
    case :ets.lookup(@table, EpisodeKey.authority_key(episode)) do
      [{_episode, _poller, access, read_at, failure}] -> {access, read_at, failure}
      [] -> :missing
    end
  end

  # :fresh when the stored read decides. The socket's own connect check read the database too, so it
  # counts as a fresh read, and a stored read that started no later than that check cannot deny.
  defp freshness(read_at, failure, connected_at) do
    fresh_at = newest(read_at, connected_at)

    cond do
      is_nil(fresh_at) or System.monotonic_time(:millisecond) - fresh_at > stale_ms() ->
        {:retryable, {:storage_unavailable, failure || "stale"}}

      is_nil(read_at) or (is_integer(connected_at) and read_at <= connected_at) ->
        :ok

      true ->
        :fresh
    end
  end

  defp newest(nil, connected_at), do: connected_at
  defp newest(read_at, nil), do: read_at
  defp newest(read_at, connected_at), do: max(read_at, connected_at)

  @doc false
  def store(episode, access, read_at, failure),
    do: :ets.insert(@table, {EpisodeKey.authority_key(episode), self(), access, read_at, failure})

  defp stale_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_stale_ms, @stale_ms)

  # Removing a Participant or ending an Episode passes through leaving or ending, and a failed
  # provider operation restores active. Only the final states close the socket. The read skips
  # left rows, and the socket's connect check found this Participant, so a missing row means the
  # Participant left.
  defp decide(nil, _identity), do: :ok

  defp decide(%{status: episode_status, participants: participants}, identity) do
    key = {String.downcase(identity.participant_id), identity.participant_generation}

    case {episode_status, Map.get(participants, key)} do
      {"ended", _status} -> {:error, {:permission_denied, :episode_ended}}
      {_episode, nil} -> {:error, {:permission_denied, :participant_inactive}}
      {_episode, "left"} -> {:error, {:permission_denied, :participant_inactive}}
      {_episode, _reversible_or_active} -> :ok
    end
  end
end
