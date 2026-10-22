defmodule ChalkSync.WhiteboardV1.Authority do
  @moduledoc """
  Whether a live whiteboard socket may keep exchanging frames.

  Fanout delivers each change to every socket in the Episode, so the Episode's lifecycle states
  are read at most once a second per node and shared by all of its sockets.
  """

  use GenServer

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.WhiteboardV1.Repository

  @table __MODULE__
  @ttl_ms 1_000
  # A refresh that crashed must not stop the next socket from reading.
  @claim_ms 2_000

  @type access :: :ok | {:error, :permission_denied} | {:retryable, {atom(), String.t()}}

  def start_link(_options), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(nil), do: {:ok, :ets.new(@table, [:named_table, :public, read_concurrency: true])}

  @spec ttl_ms() :: non_neg_integer()
  def ttl_ms, do: Application.get_env(:chalk_sync, :whiteboard_authority_ttl_ms, @ttl_ms)

  @spec check(Identity.t()) :: access()
  def check(%Identity{} = identity) do
    now_ms = System.monotonic_time(:millisecond)
    ttl_ms = ttl_ms()

    case :ets.lookup(@table, identity.episode) do
      [{_episode, checked_at, access}] when now_ms - checked_at < ttl_ms ->
        decide(access, identity)

      cached ->
        refresh(identity, cached, now_ms)
    end
  end

  defp refresh(identity, cached, now_ms) do
    claim = {:refresh, identity.episode}

    case {claim(claim, now_ms), cached} do
      # Another socket is reading; the access it replaces is at most a second or two old.
      {false, [{_episode, _checked_at, access}]} ->
        decide(access, identity)

      _claimed_or_first ->
        result = Repository.episode_access(identity.episode)
        :ets.delete(@table, claim)

        case result do
          {:ok, access} ->
            :ets.insert(@table, {identity.episode, now_ms, access})
            decide(access, identity)

          {:error, :not_found} ->
            {:error, :permission_denied}

          {:retryable, _reason} = unavailable ->
            unavailable
        end
    end
  end

  defp claim(claim, now_ms) do
    :ets.insert_new(@table, {claim, now_ms}) or
      (:ets.select_delete(@table, [{{claim, :"$1"}, [{:<, :"$1", now_ms - @claim_ms}], [true]}]) ==
         1 and
         :ets.insert_new(@table, {claim, now_ms}))
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
end
