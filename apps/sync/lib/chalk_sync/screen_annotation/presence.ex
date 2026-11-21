defmodule ChalkSync.ScreenAnnotation.Presence do
  @moduledoc "Bounded latest values, authorized by the socket's committed layer witness."

  use GenServer

  alias ChalkSync.Stateholder.EpisodeKey

  @interval 34
  @relay_batch_size 128

  def start_link(opts), do: GenServer.start_link(__MODULE__, opts, name: __MODULE__)

  def watch_listener, do: GenServer.call(__MODULE__, :watch_listener)
  def listener_status(status), do: GenServer.call(__MODULE__, {:listener_status, status})

  def join(episode, participant_id),
    do: GenServer.call(__MODULE__, {:join, episode, participant_id, self()})

  def leave, do: GenServer.cast(__MODULE__, {:leave, self()})

  def begin_refresh(identity),
    do:
      GenServer.call(
        __MODULE__,
        {:begin_refresh, identity.episode, identity.participant_id, self()}
      )

  def confirm(epoch, witness), do: GenServer.call(__MODULE__, {:confirm, self(), epoch, witness})

  def publish(frame), do: GenServer.call(__MODULE__, {:publish, self(), frame})

  def take, do: GenServer.call(__MODULE__, {:take, self()})

  def take_relay, do: GenServer.call(__MODULE__, :take_relay)

  def change(episode, invalidates?),
    do: GenServer.cast(__MODULE__, {:change, episode, invalidates?})

  def relay(episode, frame), do: GenServer.cast(__MODULE__, {:relay, episode, frame})

  @impl true
  def init(opts) do
    Process.send_after(self(), :sweep, 1_000)

    state = %{
      sockets: %{},
      rates: %{},
      relays: %{},
      listener: nil,
      local_only?: opts[:local_only]
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:watch_listener, {pid, _tag}, state) do
    if state.listener, do: Process.demonitor(elem(state.listener, 1), [:flush])
    listener = {pid, Process.monitor(pid), :offline}
    {:reply, :ok, reset_witnesses(%{state | listener: listener})}
  end

  def handle_call({:listener_status, status}, {pid, _tag}, %{listener: {pid, ref, _}} = state) do
    {:reply, :ok, reset_witnesses(%{state | listener: {pid, ref, status}})}
  end

  def handle_call({:join, episode, participant_id, pid}, _from, state) do
    {:reply, :ok, register(state, episode, participant_id, pid)}
  end

  def handle_call({:begin_refresh, episode, participant_id, pid}, _from, state) do
    state = register(state, episode, participant_id, pid)
    socket = state.sockets[pid]
    {:reply, socket.epoch, put_in(state.sockets[pid].dirty, false)}
  end

  def handle_call({:confirm, pid, epoch, witness}, _from, state) do
    case state.sockets[pid] do
      %{epoch: ^epoch} ->
        witness = if listener_ready?(state), do: witness
        {:reply, :ok, put_in(state.sockets[pid].witness, witness)}

      _ ->
        {:reply, :stale, state}
    end
  end

  def handle_call({:take, pid}, _from, state) do
    case state.sockets[pid] do
      nil -> {:reply, [], state}
      socket -> {:reply, Map.values(socket.pending), put_in(state.sockets[pid].pending, %{})}
    end
  end

  def handle_call({:publish, pid, frame}, _from, state) do
    with %{witness: %{can_draw: true} = witness} = sender <- state.sockets[pid],
         true <- matching?(witness, frame) do
      publish_latest(state, pid, sender, frame)
    else
      _ -> {:reply, :dropped, state}
    end
  end

  def handle_call(:take_relay, _from, state) do
    batch = state.relays |> Stream.take(@relay_batch_size) |> Enum.to_list()

    {:reply, Enum.map(batch, &elem(&1, 1)),
     %{state | relays: Map.drop(state.relays, Enum.map(batch, &elem(&1, 0)))}}
  end

  @impl true
  def handle_cast({:change, episode, invalidates?}, state) do
    state =
      Enum.reduce(:pg.get_local_members(group(episode)), state, fn pid, state ->
        case state.sockets[pid] do
          nil ->
            state

          socket ->
            put_in(state.sockets[pid], invalidate_socket(socket, pid, invalidates?))
        end
      end)

    relays =
      if invalidates?,
        do: Map.reject(state.relays, fn {{key, _actor}, _sample} -> key == scope(episode) end),
        else: state.relays

    {:noreply, %{state | relays: relays}}
  end

  def handle_cast({:relay, episode, frame}, state),
    do: {:noreply, deliver_local(state, episode, frame, nil)}

  def handle_cast({:leave, pid}, state), do: {:noreply, remove(state, pid)}

  @impl true
  def handle_info(:sweep, state) do
    floor = System.monotonic_time(:millisecond) - 2_000
    now = System.system_time(:millisecond)
    rates = Map.reject(state.rates, fn {_key, {time, _pid}} -> time <= floor end)

    relays =
      Map.reject(state.relays, fn {_key, {_episode, sample}} -> sample["expires_at_ms"] <= now end)

    Process.send_after(self(), :sweep, 1_000)
    {:noreply, %{state | rates: rates, relays: relays}}
  end

  def handle_info({:DOWN, ref, :process, pid, _reason}, %{listener: {pid, ref, _}} = state),
    do: {:noreply, reset_witnesses(%{state | listener: nil})}

  def handle_info({:DOWN, ref, :process, pid, _reason}, state) do
    case state.sockets[pid] do
      %{ref: ^ref} -> {:noreply, remove(state, pid)}
      _ -> {:noreply, state}
    end
  end

  defp listener_ready?(%{listener: {_pid, _ref, :ready}}), do: true
  defp listener_ready?(%{listener: nil, local_only?: true}), do: true
  defp listener_ready?(_state), do: false

  defp reset_witnesses(state) do
    sockets =
      Map.new(state.sockets, fn {pid, socket} -> {pid, invalidate_socket(socket, pid, true)} end)

    %{state | sockets: sockets, relays: %{}}
  end

  defp invalidate_socket(socket, pid, invalidates?) do
    if not socket.dirty, do: send(pid, :annotation_changed)
    next = %{socket | dirty: true}

    if invalidates?,
      do: %{next | epoch: next.epoch + 1, pending: %{}, last: nil, witness: nil},
      else: next
  end

  defp publish_latest(state, pid, sender, frame) do
    now = System.monotonic_time(:millisecond)
    key = {scope(sender.episode), sender.actor}
    removing? = removal?(frame)
    previous = state.rates[key]

    cond do
      removing? and (is_nil(sender.last) or not match?({_, ^pid}, previous)) ->
        {:reply, :dropped, state}

      not removing? and throttled?(previous, now) ->
        {:reply, :dropped, state}

      true ->
        state = put_in(state.rates[key], {now, pid})
        state = put_in(state.sockets[pid].last, if(removing?, do: nil, else: frame))
        {:reply, :ok, deliver_local_and_queue(state, sender.episode, frame, pid)}
    end
  end

  defp register(%{sockets: sockets} = state, _episode, _actor, pid) when is_map_key(sockets, pid),
    do: state

  defp register(state, episode, participant_id, pid) do
    unless pid in :pg.get_local_members(group(episode)), do: :pg.join(group(episode), pid)
    ref = Process.monitor(pid)

    socket = %{
      ref: ref,
      episode: episode,
      actor: participant_id,
      pending: %{},
      last: nil,
      epoch: 0,
      dirty: false,
      witness: nil
    }

    put_in(state.sockets[pid], socket)
  end

  defp remove(state, pid) do
    case Map.pop(state.sockets, pid) do
      {nil, _sockets} ->
        state

      {sender, sockets} ->
        Process.demonitor(sender.ref, [:flush])
        :pg.leave(group(sender.episode), pid)
        state = %{state | sockets: sockets}

        previous = state.rates[{scope(sender.episode), sender.actor}]

        if sender.last && match?({_, ^pid}, previous) && matching?(sender.witness, sender.last) do
          frame = %{sender.last | "cursor" => nil, "draft" => nil}
          deliver_local_and_queue(state, sender.episode, frame, pid)
        else
          state
        end
    end
  end

  defp deliver_local_and_queue(state, episode, frame, except) do
    state = deliver_local(state, episode, frame, except)
    key = {scope(episode), frame["author"]["participant_id"]}
    put_in(state.relays[key], {episode, frame})
  end

  defp deliver_local(state, episode, frame, except) do
    author = frame["author"]["participant_id"]

    Enum.reduce(:pg.get_local_members(group(episode)), state, fn pid, state ->
      deliver_to_socket(state, pid, except, author, frame)
    end)
  end

  defp deliver_to_socket(state, pid, except, author, frame) do
    with false <- pid == except,
         %{witness: witness, pending: pending} <- state.sockets[pid],
         true <- matching?(witness, frame),
         true <- newer?(pending[author], frame) do
      if map_size(pending) == 0, do: send(pid, :annotation_presence_ready)
      put_in(state.sockets[pid].pending[author], frame)
    else
      _ -> state
    end
  end

  defp matching?(%{layer: layer, fence: fence, until: until}, %{
         "layer_id" => layer,
         "fence" => fence
       }),
       do: until > System.system_time(:millisecond)

  defp matching?(_witness, _frame), do: false

  defp newer?(nil, _frame), do: true
  defp newer?(previous, frame), do: frame["server_at_ms"] >= previous["server_at_ms"]

  defp throttled?({time, _pid}, now), do: now - time < @interval
  defp throttled?(nil, _now), do: false

  defp removal?(frame), do: is_nil(frame["draft"]) and is_nil(frame["cursor"])
  defp group(episode), do: {__MODULE__, scope(episode)}
  defp scope(episode), do: EpisodeKey.authority_key(episode)
end
