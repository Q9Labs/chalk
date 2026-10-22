defmodule ChalkSync.Admission do
  @moduledoc """
  Bounded node-local reaction and chat rate admission.

  Each Participant gets its own window per kind, so this state is deliberately
  disposable: a node restart only resets the windows. Chat still has durable
  per-Participant caps in its repository.
  """

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  @window_ms 10_000
  @rate_max 10
  @chat_rate_max 30
  @actor_limit 4_096

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @spec admit_reaction(GenServer.server(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit_reaction(
        server \\ __MODULE__,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ) do
    admit(server, :reaction, identity, now_ms)
  end

  @spec admit_chat(GenServer.server(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit_chat(
        server \\ __MODULE__,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ) do
    admit(server, :chat, identity, now_ms)
  end

  defp admit(server, kind, identity, now_ms) do
    GenServer.call(server, {:admit, {kind, actor_key(identity)}, now_ms}, 1_000)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec stats(GenServer.server()) :: %{actors: non_neg_integer(), reservations: non_neg_integer()}
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(options) do
    {:ok,
     %{
       actors: %{},
       window_ms: Keyword.get(options, :window_ms, @window_ms),
       rate_max: %{
         reaction: Keyword.get(options, :rate_max, @rate_max),
         chat: Keyword.get(options, :chat_rate_max, @chat_rate_max)
       },
       actor_limit: Keyword.get(options, :actor_limit, @actor_limit)
     }}
  end

  @impl true
  def handle_call({:admit, {kind, _actor} = key, now_ms}, _from, state) do
    actors = prune_actors(state.actors, now_ms - state.window_ms)
    timestamps = Map.get(actors, key, [])

    cond do
      length(timestamps) >= Map.fetch!(state.rate_max, kind) ->
        {:reply, {:error, :rate_limited}, %{state | actors: Map.put(actors, key, timestamps)}}

      timestamps == [] and map_size(actors) >= state.actor_limit ->
        {:reply, {:error, :overloaded}, %{state | actors: actors}}

      true ->
        {:reply, :ok, %{state | actors: Map.put(actors, key, timestamps ++ [now_ms])}}
    end
  end

  def handle_call(:stats, _from, state) do
    reservations = state.actors |> Map.values() |> Enum.map(&length/1) |> Enum.sum()
    {:reply, %{actors: map_size(state.actors), reservations: reservations}, state}
  end

  defp prune_actors(actors, cutoff) do
    Map.new(actors, fn {key, timestamps} ->
      # Callers read the clock before the call, so timestamps can arrive out of order.
      {key, Enum.filter(timestamps, &(&1 > cutoff))}
    end)
    |> Map.reject(fn {_key, timestamps} -> timestamps == [] end)
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
