defmodule ChalkSync.Admission do
  @moduledoc """
  Bounded node-local collaboration admission.

  Collaboration delivery is transient, so this state is deliberately
  disposable. A chat-attempt budget protects database access before durable
  checks, while new-message and reaction slots are reserved only after durable
  membership and capability checks. Whiteboard socket ownership is monitored
  so a crashed socket cannot hold a connection slot indefinitely.
  """

  use GenServer

  alias ChalkSync.Admission.CursorBudget
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity

  @window_ms 10_000
  @rate_max 10
  @actor_limit 4_096
  @cursor_window_ms 1_000
  @cursor_rate_max 60
  @chat_attempt_window_ms 10_000
  @chat_attempt_rate_max 60
  @chat_window_ms 10_000
  @chat_rate_max 30
  @whiteboard_socket_limit 2

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

  @spec admit_cursor(CursorBudget.t(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited}
  def admit_cursor(
        %CursorBudget{} = budget,
        %Identity{} = _identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ) do
    CursorBudget.admit(budget, now_ms)
  end

  @spec admit_chat_attempt(GenServer.server(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit_chat_attempt(
        server \\ __MODULE__,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ) do
    GenServer.call(server, {:admit, :chat_attempt, actor_key(identity), now_ms}, 1_000)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec admit_chat(GenServer.server(), Identity.t(), integer()) ::
          :ok | {:error, :rate_limited | :overloaded}
  def admit_chat(
        server \\ __MODULE__,
        %Identity{} = identity,
        now_ms \\ System.monotonic_time(:millisecond)
      ) do
    GenServer.call(server, {:admit, :chat, actor_key(identity), now_ms}, 1_000)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec open_whiteboard(GenServer.server(), Identity.t(), pid()) ::
          {:ok, CursorBudget.t()} | {:error, :overloaded}
  def open_whiteboard(server \\ __MODULE__, %Identity{} = identity, owner \\ self())
      when is_pid(owner) do
    GenServer.call(server, {:open_whiteboard, actor_key(identity), owner}, 1_000)
  catch
    :exit, _reason -> {:error, :overloaded}
  end

  @spec close_whiteboard(GenServer.server(), Identity.t(), pid()) :: :ok
  def close_whiteboard(server \\ __MODULE__, %Identity{} = identity, owner \\ self())
      when is_pid(owner) do
    GenServer.call(server, {:close_whiteboard, actor_key(identity), owner}, 1_000)
  catch
    :exit, _reason -> :ok
  end

  @spec stats(GenServer.server()) :: %{actors: non_neg_integer(), reservations: non_neg_integer()}
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(options) do
    {:ok,
     %{
       actors: %{},
       chat_attempt_actors: %{},
       chat_actors: %{},
       whiteboard_sockets: %{},
       cursor_budgets: %{},
       socket_refs: %{},
       window_ms: Keyword.get(options, :window_ms, @window_ms),
       rate_max: Keyword.get(options, :rate_max, @rate_max),
       actor_limit: Keyword.get(options, :actor_limit, @actor_limit),
       cursor_window_ms: Keyword.get(options, :cursor_window_ms, @cursor_window_ms),
       cursor_rate_max: Keyword.get(options, :cursor_rate_max, @cursor_rate_max),
       cursor_actor_limit: Keyword.get(options, :cursor_actor_limit, @actor_limit),
       chat_attempt_window_ms:
         Keyword.get(options, :chat_attempt_window_ms, @chat_attempt_window_ms),
       chat_attempt_rate_max:
         Keyword.get(options, :chat_attempt_rate_max, @chat_attempt_rate_max),
       chat_attempt_actor_limit: Keyword.get(options, :chat_attempt_actor_limit, @actor_limit),
       chat_window_ms: Keyword.get(options, :chat_window_ms, @chat_window_ms),
       chat_rate_max: Keyword.get(options, :chat_rate_max, @chat_rate_max),
       chat_actor_limit: Keyword.get(options, :chat_actor_limit, @actor_limit),
       whiteboard_actor_limit: Keyword.get(options, :whiteboard_actor_limit, @actor_limit),
       whiteboard_socket_limit:
         Keyword.get(options, :whiteboard_socket_limit, @whiteboard_socket_limit)
     }}
  end

  @impl true
  def handle_call({:admit_reaction, key, now_ms}, _from, state) do
    {reply, actors} =
      admit_policy(state.actors, key, now_ms, %{
        window_ms: state.window_ms,
        rate_max: state.rate_max,
        actor_limit: state.actor_limit
      })

    {:reply, reply, %{state | actors: actors}}
  end

  def handle_call({:admit, :chat, key, now_ms}, _from, state) do
    {reply, actors} =
      admit_policy(state.chat_actors, key, now_ms, %{
        window_ms: state.chat_window_ms,
        rate_max: state.chat_rate_max,
        actor_limit: state.chat_actor_limit
      })

    {:reply, reply, %{state | chat_actors: actors}}
  end

  def handle_call({:admit, :chat_attempt, key, now_ms}, _from, state) do
    {reply, actors} =
      admit_policy(state.chat_attempt_actors, key, now_ms, %{
        window_ms: state.chat_attempt_window_ms,
        rate_max: state.chat_attempt_rate_max,
        actor_limit: state.chat_attempt_actor_limit
      })

    {:reply, reply, %{state | chat_attempt_actors: actors}}
  end

  def handle_call(:stats, _from, state) do
    now_ms = System.monotonic_time(:millisecond)
    state = prune_expired(state, now_ms)
    reservations = state.actors |> Map.values() |> Enum.map(&length/1) |> Enum.sum()
    {:reply, %{actors: map_size(state.actors), reservations: reservations}, state}
  end

  def handle_call({:open_whiteboard, key, owner}, _from, state) do
    sockets = Map.get(state.whiteboard_sockets, key, %{})

    cond do
      Map.has_key?(sockets, owner) ->
        {:reply, {:ok, Map.fetch!(state.cursor_budgets, key)}, state}

      not Map.has_key?(state.whiteboard_sockets, key) and
          map_size(state.whiteboard_sockets) >=
            min(state.whiteboard_actor_limit, state.cursor_actor_limit) ->
        {:reply, {:error, :overloaded}, state}

      map_size(sockets) >= state.whiteboard_socket_limit ->
        {:reply, {:error, :overloaded}, state}

      true ->
        reference = Process.monitor(owner)
        sockets = Map.put(sockets, owner, reference)

        budget =
          Map.get_lazy(state.cursor_budgets, key, fn ->
            CursorBudget.new(state.cursor_rate_max, state.cursor_window_ms)
          end)

        {:reply, {:ok, budget},
         %{
           state
           | whiteboard_sockets: Map.put(state.whiteboard_sockets, key, sockets),
             cursor_budgets: Map.put(state.cursor_budgets, key, budget),
             socket_refs: Map.put(state.socket_refs, reference, {key, owner})
         }}
    end
  end

  def handle_call({:close_whiteboard, key, owner}, _from, state) do
    {:reply, :ok, release_socket(state, key, owner)}
  end

  @impl true
  def handle_info({:DOWN, reference, :process, owner, _reason}, state) do
    case Map.pop(state.socket_refs, reference) do
      {{key, ^owner}, socket_refs} ->
        {:noreply, release_socket(%{state | socket_refs: socket_refs}, key, owner, false)}

      {nil, _socket_refs} ->
        {:noreply, state}
    end
  end

  defp admit_policy(actors, key, now_ms, policy) do
    timestamps = actors |> Map.get(key, []) |> Enum.drop_while(&(&1 <= now_ms - policy.window_ms))

    cond do
      length(timestamps) >= policy.rate_max ->
        {{:error, :rate_limited}, Map.put(actors, key, timestamps)}

      timestamps == [] and map_size(actors) >= policy.actor_limit ->
        admit_after_prune(actors, key, now_ms, policy)

      true ->
        {:ok, Map.put(actors, key, timestamps ++ [now_ms])}
    end
  end

  defp prune_expired(state, now_ms) do
    %{
      state
      | actors: prune_actors(state.actors, now_ms - state.window_ms),
        chat_attempt_actors:
          prune_actors(
            state.chat_attempt_actors,
            now_ms - state.chat_attempt_window_ms
          ),
        chat_actors: prune_actors(state.chat_actors, now_ms - state.chat_window_ms)
    }
  end

  defp admit_after_prune(actors, key, now_ms, policy) do
    actors = prune_actors(actors, now_ms - policy.window_ms)

    if map_size(actors) >= policy.actor_limit,
      do: {{:error, :overloaded}, actors},
      else: {:ok, Map.put(actors, key, [now_ms])}
  end

  defp release_socket(state, key, owner, demonitor? \\ true) do
    case get_in(state.whiteboard_sockets, [key, owner]) do
      nil ->
        state

      reference ->
        if demonitor?, do: Process.demonitor(reference, [:flush])

        sockets = Map.get(state.whiteboard_sockets, key, %{}) |> Map.delete(owner)

        whiteboard_sockets =
          if map_size(sockets) == 0,
            do: Map.delete(state.whiteboard_sockets, key),
            else: Map.put(state.whiteboard_sockets, key, sockets)

        cursor_budgets =
          if map_size(sockets) == 0,
            do: Map.delete(state.cursor_budgets, key),
            else: state.cursor_budgets

        %{
          state
          | whiteboard_sockets: whiteboard_sockets,
            cursor_budgets: cursor_budgets,
            socket_refs: Map.delete(state.socket_refs, reference)
        }
    end
  end

  defp prune_actors(actors, cutoff) do
    Map.new(actors, fn {key, timestamps} ->
      {key, Enum.drop_while(timestamps, &(&1 <= cutoff))}
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
