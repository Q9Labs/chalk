defmodule ChalkSync.Admission do
  @moduledoc """
  Bounded node-local reaction and chat rate admission.

  Each Participant gets its own window per kind, so this state is deliberately
  disposable: a node restart only resets the windows. Chat still has durable
  per-person caps in its repository.
  """

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  @kinds [:reaction, :chat, :chat_retry]
  @window_ms 10_000
  @rate_max %{reaction: 10, chat: 30, chat_retry: 30}
  @actor_limit 4_096

  @type kind :: :reaction | :chat | :chat_retry

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @doc """
  Takes one slot of `kind` for the Participant. `:chat_retry` bounds the receipt
  lookups a Participant can cause after its `:chat` window is full.
  """
  @spec admit(GenServer.server(), kind(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit(
        server \\ __MODULE__,
        kind,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      )
      when kind in @kinds do
    GenServer.call(server, {:admit, kind, actor_key(identity), now_ms}, 1_000)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec admit_reaction(GenServer.server(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit_reaction(
        server \\ __MODULE__,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ),
      do: admit(server, :reaction, identity, now_ms)

  @spec stats(GenServer.server()) :: %{actors: non_neg_integer(), reservations: non_neg_integer()}
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(options) do
    rate_max = Map.merge(@rate_max, Map.new(Keyword.get(options, :rate_max, [])))

    {:ok,
     %{
       actors: Map.new(@kinds, &{&1, %{}}),
       window_ms: Keyword.get(options, :window_ms, @window_ms),
       rate_max: rate_max,
       actor_limit: Keyword.get(options, :actor_limit, @actor_limit)
     }}
  end

  @impl true
  def handle_call({:admit, kind, actor, now_ms}, _from, state) do
    actors = prune_actors(state.actors[kind], now_ms - state.window_ms)
    timestamps = Map.get(actors, actor, [])

    {reply, actors} =
      cond do
        length(timestamps) >= state.rate_max[kind] ->
          {{:error, :rate_limited}, actors}

        timestamps == [] and map_size(actors) >= state.actor_limit ->
          {{:error, :overloaded}, actors}

        true ->
          {:ok, Map.put(actors, actor, [now_ms | timestamps])}
      end

    {:reply, reply, put_in(state.actors[kind], actors)}
  end

  def handle_call(:stats, _from, state) do
    by_actor = state.actors |> Map.values() |> Enum.flat_map(&Map.values/1)

    {:reply,
     %{actors: length(by_actor), reservations: by_actor |> Enum.map(&length/1) |> Enum.sum()},
     state}
  end

  defp prune_actors(actors, cutoff) do
    Map.new(actors, fn {actor, timestamps} ->
      # Callers read the clock before the call, so timestamps can arrive out of order.
      {actor, Enum.filter(timestamps, &(&1 > cutoff))}
    end)
    |> Map.reject(fn {_actor, timestamps} -> timestamps == [] end)
  end

  defp actor_key(identity) do
    {tenant_id, episode_id} = EpisodeKey.authority_key(identity.episode)

    {
      tenant_id,
      episode_id,
      String.downcase(identity.participant_id),
      identity.participant_generation
    }
  end
end
