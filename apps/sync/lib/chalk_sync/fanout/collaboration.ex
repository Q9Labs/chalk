defmodule ChalkSync.Fanout.Collaboration do
  @moduledoc """
  Bounded node-local subscriber registry for space-action fan-out.

  Durable chat heads and transient reactions share no retained payload state.
  Slow socket mailboxes are skipped; clients repair missed chat hints from the
  authoritative head and reactions are intentionally lossy.
  """

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey

  @episode_limit 4_096
  @subscribers_per_episode 1_024
  @subscriber_mailbox_limit 128

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @spec subscribe(GenServer.server(), EpisodeKey.t(), pid()) ::
          :ok | {:error, :overloaded | :dependency_unavailable}
  def subscribe(server \\ __MODULE__, %EpisodeKey{} = episode, subscriber \\ self()) do
    GenServer.call(server, {:subscribe, key(episode), subscriber}, 1_000)
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec unsubscribe(GenServer.server(), EpisodeKey.t(), pid()) :: :ok
  def unsubscribe(server \\ __MODULE__, %EpisodeKey{} = episode, subscriber \\ self()) do
    GenServer.call(server, {:unsubscribe, key(episode), subscriber}, 1_000)
  catch
    :exit, _reason -> :ok
  end

  @spec publish_chat_head(GenServer.server(), EpisodeKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_chat_head(server \\ __MODULE__, %EpisodeKey{} = episode, head) do
    frame = chat_head_frame(head)
    transport = GenServer.call(server, {:publish, episode, frame}, 1_000)
    publish_external(transport, :chat_head, episode, frame)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec publish_reaction(GenServer.server(), EpisodeKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_reaction(server \\ __MODULE__, %EpisodeKey{} = episode, event) do
    transport = GenServer.call(server, {:publish, episode, event}, 1_000)
    publish_external(transport, :reaction, episode, event)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec publish_chat_read_receipt(GenServer.server(), EpisodeKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_chat_read_receipt(server \\ __MODULE__, %EpisodeKey{} = episode, receipt) do
    transport = GenServer.call(server, {:publish, episode, receipt}, 1_000)
    publish_external(transport, :chat_read_receipt, episode, receipt)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec accept_external(GenServer.server(), :chat_head | :reaction, EpisodeKey.t(), map()) :: :ok
  def accept_external(server \\ __MODULE__, kind, %EpisodeKey{} = episode, frame)
      when kind in [:chat_head, :chat_read_receipt, :reaction] do
    GenServer.cast(server, {:external, key(episode), frame})
  end

  @spec stats(GenServer.server()) :: %{
          episodes: non_neg_integer(),
          subscribers: non_neg_integer()
        }
  def stats(server \\ __MODULE__), do: GenServer.call(server, :stats)

  @impl true
  def init(options) do
    {:ok,
     %{
       subscribers: %{},
       monitors: %{},
       transport: Keyword.get(options, :transport),
       episode_limit: Keyword.get(options, :episode_limit, @episode_limit),
       subscriber_limit: Keyword.get(options, :subscriber_limit, @subscribers_per_episode),
       mailbox_limit: Keyword.get(options, :mailbox_limit, @subscriber_mailbox_limit)
     }}
  end

  @impl true
  def handle_call({:subscribe, episode_key, subscriber}, _from, state) do
    subscribers = Map.get(state.subscribers, episode_key, MapSet.new())

    cond do
      MapSet.member?(subscribers, subscriber) ->
        {:reply, :ok, state}

      map_size(state.subscribers) >= state.episode_limit and subscribers == MapSet.new() ->
        {:reply, {:error, :overloaded}, state}

      MapSet.size(subscribers) >= state.subscriber_limit ->
        {:reply, {:error, :overloaded}, state}

      true ->
        monitor = Process.monitor(subscriber)

        next = %{
          state
          | subscribers:
              Map.put(state.subscribers, episode_key, MapSet.put(subscribers, subscriber)),
            monitors: Map.put(state.monitors, monitor, {episode_key, subscriber})
        }

        {:reply, :ok, next}
    end
  end

  def handle_call({:unsubscribe, episode_key, subscriber}, _from, state) do
    {:reply, :ok, remove_subscriber(state, episode_key, subscriber)}
  end

  def handle_call({:publish, episode, frame}, _from, state) do
    deliver(state, key(episode), frame)
    {:reply, state.transport, state}
  end

  def handle_call(:stats, _from, state) do
    subscribers =
      state.subscribers |> Map.values() |> Enum.map(&MapSet.size/1) |> Enum.sum()

    {:reply, %{episodes: map_size(state.subscribers), subscribers: subscribers}, state}
  end

  @impl true
  def handle_cast({:external, episode_key, frame}, state) do
    deliver(state, episode_key, frame)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, monitor) do
      {nil, _monitors} ->
        {:noreply, state}

      {{episode_key, subscriber}, monitors} ->
        next =
          state
          |> Map.put(:monitors, monitors)
          |> remove_subscriber(episode_key, subscriber, demonitor?: false)

        {:noreply, next}
    end
  end

  defp deliver(state, episode_key, frame) do
    state.subscribers
    |> Map.get(episode_key, MapSet.new())
    |> Enum.each(fn subscriber ->
      case Process.info(subscriber, :message_queue_len) do
        {:message_queue_len, length} when length < state.mailbox_limit ->
          send(subscriber, {:collaboration_frame, frame})

        _ ->
          :ok
      end
    end)
  end

  defp publish_external(nil, _kind, _episode, _frame), do: :ok

  defp publish_external({module, adapter}, :chat_head, episode, frame) do
    module.publish_chat_head(adapter, episode, %{
      head_sequence: frame["head_sequence"],
      retained_floor_sequence: frame["retained_floor_sequence"]
    })
  end

  defp publish_external({module, adapter}, :reaction, episode, frame) do
    module.publish_reaction(adapter, episode, frame)
  end

  defp publish_external({module, adapter}, :chat_read_receipt, episode, frame) do
    module.publish_chat_read_receipt(adapter, episode, frame)
  end

  defp remove_subscriber(state, episode_key, subscriber, options \\ []) do
    demonitor? = Keyword.get(options, :demonitor?, true)
    current = Map.get(state.subscribers, episode_key, MapSet.new())
    subscribers = MapSet.delete(current, subscriber)

    next_subscribers =
      if MapSet.size(subscribers) == 0,
        do: Map.delete(state.subscribers, episode_key),
        else: Map.put(state.subscribers, episode_key, subscribers)

    {monitor, monitors} = pop_monitor(state.monitors, episode_key, subscriber)
    if demonitor? and monitor, do: Process.demonitor(monitor, [:flush])
    %{state | subscribers: next_subscribers, monitors: monitors}
  end

  defp pop_monitor(monitors, episode_key, subscriber) do
    case Enum.find(monitors, fn {_monitor, value} -> value == {episode_key, subscriber} end) do
      nil -> {nil, monitors}
      {monitor, _value} -> {monitor, Map.delete(monitors, monitor)}
    end
  end

  defp chat_head_frame(head) do
    %{
      "type" => "chat_head",
      "head_sequence" => head.head_sequence,
      "retained_floor_sequence" => head.retained_floor_sequence
    }
  end

  defp key(episode) do
    {
      String.downcase(episode.tenant_id),
      String.downcase(episode.episode_id)
    }
  end
end
