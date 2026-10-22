defmodule ChalkSync.WhiteboardV1.Authority do
  @moduledoc """
  Whether a live whiteboard socket may keep exchanging frames.

  While any whiteboard socket of an Episode is live on this node, one `Authority.Poller` reads the
  Episode's lifecycle states every second and stores them here. Sockets only look up the stored
  result, on every frame and on a one-second tick, so a large call costs one database read per
  second per node whether its boards are busy or idle.
  """

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Authority.Poller

  @table __MODULE__
  @poll_ms 1_000
  # Without a successful read for this long, sockets close so their clients reconnect.
  @stale_ms 3_000

  @type access :: :ok | {:error, :permission_denied} | {:retryable, {atom(), String.t()}}

  def start_link(_options), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, read_concurrency: true])
    {:ok, nil}
  end

  @spec poll_ms() :: pos_integer()
  def poll_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_poll_ms, @poll_ms)

  @doc "Keeps the Episode's access current while the calling socket is alive."
  @spec watch(EpisodeKey.t()) :: :ok
  def watch(%EpisodeKey{} = episode), do: Poller.watch(episode, self())

  @spec check(Identity.t()) :: access()
  def check(%Identity{} = identity) do
    case :ets.lookup(@table, identity.episode) do
      # The socket passed a fresh check at connect, and the first read is on its way.
      [] ->
        watch(identity.episode)

      [{_episode, :not_found, _read_at, _failure}] ->
        {:error, :permission_denied}

      [{_episode, access, read_at, failure}] ->
        if System.monotonic_time(:millisecond) - read_at > stale_ms(),
          do: {:retryable, {:storage_unavailable, failure || "stale"}},
          else: decide(access, identity)
    end
  rescue
    # The table goes away with this process while it restarts.
    ArgumentError -> {:retryable, {:storage_unavailable, "authority"}}
  end

  @doc false
  def store(episode, access, read_at, failure),
    do: :ets.insert(@table, {episode, access, read_at, failure})

  @doc false
  def forget(episode), do: :ets.delete(@table, episode)

  defp stale_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_stale_ms, @stale_ms)

  # Removing a Participant or ending an Episode passes through leaving or ending, and a failed
  # provider operation restores active. Only the final states close the socket.
  defp decide(nil, _identity), do: :ok

  defp decide(%{status: episode_status, participants: participants}, identity) do
    key = {String.downcase(identity.participant_id), identity.participant_generation}

    case {episode_status, Map.get(participants, key)} do
      {"ended", _status} -> {:error, :permission_denied}
      {_episode, nil} -> {:error, :permission_denied}
      {_episode, "left"} -> {:error, :permission_denied}
      {_episode, _reversible_or_active} -> :ok
    end
  end
end
