defmodule ChalkSync.RoomActions.Fanout do
  @moduledoc """
  Bounded node-local subscriber registry for room-action fan-out.

  Durable chat heads and transient reactions share no retained payload state.
  Slow socket mailboxes are skipped; clients repair missed chat hints from the
  authoritative head and reactions are intentionally lossy.
  """

  use GenServer

  alias ChalkSync.Stateholder.SessionKey

  @session_limit 4_096
  @subscribers_per_session 1_024
  @subscriber_mailbox_limit 128

  def start_link(options \\ []) do
    GenServer.start_link(__MODULE__, options, name: Keyword.get(options, :name, __MODULE__))
  end

  @spec subscribe(GenServer.server(), SessionKey.t(), pid()) ::
          :ok | {:error, :overloaded | :dependency_unavailable}
  def subscribe(server \\ __MODULE__, %SessionKey{} = session, subscriber \\ self()) do
    GenServer.call(server, {:subscribe, key(session), subscriber}, 1_000)
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec unsubscribe(GenServer.server(), SessionKey.t(), pid()) :: :ok
  def unsubscribe(server \\ __MODULE__, %SessionKey{} = session, subscriber \\ self()) do
    GenServer.call(server, {:unsubscribe, key(session), subscriber}, 1_000)
  catch
    :exit, _reason -> :ok
  end

  @spec publish_chat_head(GenServer.server(), SessionKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_chat_head(server \\ __MODULE__, %SessionKey{} = session, head) do
    frame = chat_head_frame(head)
    transport = GenServer.call(server, {:publish, session, frame}, 1_000)
    publish_external(transport, :chat_head, session, frame)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec publish_reaction(GenServer.server(), SessionKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_reaction(server \\ __MODULE__, %SessionKey{} = session, event) do
    transport = GenServer.call(server, {:publish, session, event}, 1_000)
    publish_external(transport, :reaction, session, event)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec publish_chat_read_receipt(GenServer.server(), SessionKey.t(), map()) ::
          :ok | {:error, :dependency_unavailable}
  def publish_chat_read_receipt(server \\ __MODULE__, %SessionKey{} = session, receipt) do
    transport = GenServer.call(server, {:publish, session, receipt}, 1_000)
    publish_external(transport, :chat_read_receipt, session, receipt)
    :ok
  catch
    :exit, _reason -> {:error, :dependency_unavailable}
  end

  @spec accept_external(GenServer.server(), :chat_head | :reaction, SessionKey.t(), map()) :: :ok
  def accept_external(server \\ __MODULE__, kind, %SessionKey{} = session, frame)
      when kind in [:chat_head, :chat_read_receipt, :reaction] do
    GenServer.cast(server, {:external, key(session), frame})
  end

  @spec stats(GenServer.server()) :: %{
          sessions: non_neg_integer(),
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
       session_limit: Keyword.get(options, :session_limit, @session_limit),
       subscriber_limit: Keyword.get(options, :subscriber_limit, @subscribers_per_session),
       mailbox_limit: Keyword.get(options, :mailbox_limit, @subscriber_mailbox_limit)
     }}
  end

  @impl true
  def handle_call({:subscribe, session_key, subscriber}, _from, state) do
    subscribers = Map.get(state.subscribers, session_key, MapSet.new())

    cond do
      MapSet.member?(subscribers, subscriber) ->
        {:reply, :ok, state}

      map_size(state.subscribers) >= state.session_limit and subscribers == MapSet.new() ->
        {:reply, {:error, :overloaded}, state}

      MapSet.size(subscribers) >= state.subscriber_limit ->
        {:reply, {:error, :overloaded}, state}

      true ->
        monitor = Process.monitor(subscriber)

        next = %{
          state
          | subscribers:
              Map.put(state.subscribers, session_key, MapSet.put(subscribers, subscriber)),
            monitors: Map.put(state.monitors, monitor, {session_key, subscriber})
        }

        {:reply, :ok, next}
    end
  end

  def handle_call({:unsubscribe, session_key, subscriber}, _from, state) do
    {:reply, :ok, remove_subscriber(state, session_key, subscriber)}
  end

  def handle_call({:publish, session, frame}, _from, state) do
    deliver(state, key(session), frame)
    {:reply, state.transport, state}
  end

  def handle_call(:stats, _from, state) do
    subscribers =
      state.subscribers |> Map.values() |> Enum.map(&MapSet.size/1) |> Enum.sum()

    {:reply, %{sessions: map_size(state.subscribers), subscribers: subscribers}, state}
  end

  @impl true
  def handle_cast({:external, session_key, frame}, state) do
    deliver(state, session_key, frame)
    {:noreply, state}
  end

  @impl true
  def handle_info({:DOWN, monitor, :process, _pid, _reason}, state) do
    case Map.pop(state.monitors, monitor) do
      {nil, _monitors} ->
        {:noreply, state}

      {{session_key, subscriber}, monitors} ->
        next =
          state
          |> Map.put(:monitors, monitors)
          |> remove_subscriber(session_key, subscriber, demonitor?: false)

        {:noreply, next}
    end
  end

  defp deliver(state, session_key, frame) do
    state.subscribers
    |> Map.get(session_key, MapSet.new())
    |> Enum.each(fn subscriber ->
      case Process.info(subscriber, :message_queue_len) do
        {:message_queue_len, length} when length < state.mailbox_limit ->
          send(subscriber, {:room_action_frame, frame})

        _ ->
          :ok
      end
    end)
  end

  defp publish_external(nil, _kind, _session, _frame), do: :ok

  defp publish_external({module, adapter}, :chat_head, session, frame) do
    module.publish_chat_head(adapter, session, %{
      head_sequence: frame["head_sequence"],
      retained_floor_sequence: frame["retained_floor_sequence"]
    })
  end

  defp publish_external({module, adapter}, :reaction, session, frame) do
    module.publish_reaction(adapter, session, frame)
  end

  defp publish_external({module, adapter}, :chat_read_receipt, session, frame) do
    module.publish_chat_read_receipt(adapter, session, frame)
  end

  defp remove_subscriber(state, session_key, subscriber, options \\ []) do
    demonitor? = Keyword.get(options, :demonitor?, true)
    current = Map.get(state.subscribers, session_key, MapSet.new())
    subscribers = MapSet.delete(current, subscriber)

    next_subscribers =
      if MapSet.size(subscribers) == 0,
        do: Map.delete(state.subscribers, session_key),
        else: Map.put(state.subscribers, session_key, subscribers)

    {monitor, monitors} = pop_monitor(state.monitors, session_key, subscriber)
    if demonitor? and monitor, do: Process.demonitor(monitor, [:flush])
    %{state | subscribers: next_subscribers, monitors: monitors}
  end

  defp pop_monitor(monitors, session_key, subscriber) do
    case Enum.find(monitors, fn {_monitor, value} -> value == {session_key, subscriber} end) do
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

  defp key(session) do
    {
      String.downcase(session.tenant_id),
      String.downcase(session.session_id)
    }
  end
end
