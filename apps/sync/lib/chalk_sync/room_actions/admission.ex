defmodule ChalkSync.RoomActions.Admission do
  @moduledoc """
  Bounded node-local reaction rate admission.

  Reaction delivery is transient, so this state is deliberately disposable.
  Durable membership and capability checks happen before a caller reserves a
  rate slot.
  """

  use GenServer

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.SessionKey

  @window_ms 10_000
  @rate_max 10
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
    GenServer.call(server, {:admit_reaction, actor_key(identity), now_ms}, 1_000)
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
       rate_max: Keyword.get(options, :rate_max, @rate_max),
       actor_limit: Keyword.get(options, :actor_limit, @actor_limit)
     }}
  end

  @impl true
  def handle_call({:admit_reaction, key, now_ms}, _from, state) do
    actors = prune_actors(state.actors, now_ms - state.window_ms)
    timestamps = actors |> Map.get(key, []) |> Enum.drop_while(&(&1 <= now_ms - state.window_ms))

    cond do
      length(timestamps) >= state.rate_max ->
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
      {key, Enum.drop_while(timestamps, &(&1 <= cutoff))}
    end)
    |> Map.reject(fn {_key, timestamps} -> timestamps == [] end)
  end

  defp actor_key(identity) do
    {tenant_id, session_id} = SessionKey.authority_key(identity.session)

    {
      tenant_id,
      session_id,
      String.downcase(identity.participant_session_id),
      identity.participant_session_generation
    }
  end
end
