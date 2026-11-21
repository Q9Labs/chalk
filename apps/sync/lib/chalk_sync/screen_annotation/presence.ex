defmodule ChalkSync.ScreenAnnotation.Presence do
  @moduledoc "Latest-value presence, isolated from durable Sync delivery."

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey

  @table __MODULE__
  @interval 34

  def start_link(_opts), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :set, :protected])
    Process.send_after(self(), :sweep, 1_000)
    {:ok, %{}}
  end

  def join(episode), do: GenServer.call(__MODULE__, {:join, episode, self()})
  def leave, do: GenServer.cast(__MODULE__, {:leave, self()})

  def publish(episode, frame),
    do: GenServer.call(__MODULE__, {:publish, episode, self(), frame})

  def take, do: GenServer.call(__MODULE__, {:take, self()})

  @impl true
  def handle_call({:join, episode, pid}, _from, state) do
    key = EpisodeKey.authority_key(episode)
    ref = Process.monitor(pid)
    {:reply, :ok, Map.put(state, pid, %{ref: ref, episode: key, pending: %{}, sent: nil})}
  end

  def handle_call({:take, pid}, _from, state) do
    case Map.fetch(state, pid) do
      {:ok, receiver} ->
        {:reply, Map.values(receiver.pending), put_in(state[pid].pending, %{})}

      :error ->
        {:reply, [], state}
    end
  end

  def handle_call({:publish, _episode, pid, frame}, _from, state) do
    case Map.fetch(state, pid) do
      {:ok, sender} ->
        now = System.monotonic_time(:millisecond)
        author = frame["author"]["participant_id"]
        actor_key = {sender.episode, author}
        removal? = is_nil(frame["cursor"]) and is_nil(frame["draft"])

        if removal? or rate_allowed?(actor_key, now) do
          {:reply, :ok, fanout(state, pid, sender, frame)}
        else
          {:reply, :dropped, state}
        end

      :error ->
        {:reply, :dropped, state}
    end
  end

  defp rate_allowed?(key, now) do
    case :ets.lookup(@table, key) do
      [{^key, last}] when now - last < @interval ->
        false

      _ ->
        :ets.insert(@table, {key, now})
        true
    end
  end

  defp fanout(state, pid, sender, frame) do
    author = frame["author"]["participant_id"]
    removal? = is_nil(frame["cursor"]) and is_nil(frame["draft"])
    sender = %{sender | sent: if(removal?, do: nil, else: frame)}

    Enum.reduce(state, Map.put(state, pid, sender), fn
      {^pid, _receiver}, acc ->
        acc

      {receiver_pid, %{episode: episode} = receiver}, acc when episode == sender.episode ->
        if map_size(receiver.pending) == 0, do: send(receiver_pid, :annotation_presence_ready)
        put_in(acc[receiver_pid].pending[author], frame)

      _, acc ->
        acc
    end)
  end

  @impl true
  def handle_cast({:leave, pid}, state), do: {:noreply, remove(state, pid)}

  @impl true
  def handle_info(:sweep, state) do
    floor = System.monotonic_time(:millisecond) - 1_000
    :ets.select_delete(@table, [{{:_, :"$1"}, [{:<, :"$1", floor}], [true]}])
    Process.send_after(self(), :sweep, 1_000)
    {:noreply, state}
  end

  def handle_info({:DOWN, ref, :process, pid, _reason}, state) do
    case Map.get(state, pid) do
      %{ref: ^ref} -> {:noreply, remove(state, pid)}
      _ -> {:noreply, state}
    end
  end

  defp remove(state, pid) do
    case Map.pop(state, pid) do
      {nil, state} ->
        state

      {sender, state} ->
        Process.demonitor(sender.ref, [:flush])

        case sender.sent do
          nil ->
            state

          frame ->
            key = {sender.episode, frame["author"]["participant_id"]}
            :ets.delete(@table, key)
            sender = %{sender | sent: nil}
            frame = %{frame | "cursor" => nil, "draft" => nil}
            fanout(Map.put(state, pid, sender), pid, sender, frame) |> Map.delete(pid)
        end
    end
  end
end
