defmodule ChalkSync.WhiteboardV1.ViewOwner do
  @moduledoc "Node-local owner of an Episode's disposable Follow views."
  use GenServer, restart: :temporary

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.UUID
  alias ChalkSync.WhiteboardV1.Authority

  @registry ChalkSync.WhiteboardV1.ViewRegistry
  @supervisor ChalkSync.WhiteboardV1.ViewSupervisor
  @max_streams 1024
  @join_retry_ms 1_000

  def start_link(episode) do
    GenServer.start_link(__MODULE__, episode, name: {:via, Registry, {@registry, episode}})
  end

  def join(episode, participant_id) do
    join(episode, participant_id, System.monotonic_time(:millisecond) + @join_retry_ms)
  end

  defp join(episode, participant_id, deadline) do
    with {:ok, owner} <- owner(episode) do
      GenServer.call(owner, {:join, self(), participant_id})
    end
  catch
    :exit, {reason, _call} when reason in [:noproc, :normal, :shutdown, :killed] ->
      if System.monotonic_time(:millisecond) < deadline do
        Process.sleep(5)
        join(episode, participant_id, deadline)
      else
        {:error, :restarting}
      end
  end

  def move(owner, frame, input), do: GenServer.call(owner, {:view, self(), frame, input})

  defp owner(episode) do
    case Registry.lookup(@registry, episode) do
      [{pid, _}] ->
        {:ok, pid}

      [] ->
        case DynamicSupervisor.start_child(@supervisor, {__MODULE__, episode}) do
          {:error, {:already_started, pid}} -> {:ok, pid}
          result -> result
        end
    end
  end

  @impl true
  def init(episode) do
    {:ok,
     %{
       id: UUID.generate(),
       episode: episode,
       sockets: %{},
       people: MapSet.new(),
       admitted_at: %{},
       views: %{},
       publishers: %{},
       streams: %{},
       admitted: MapSet.new(),
       relays: %{},
       legacy_views: %{}
     }}
  end

  @impl true
  def handle_call({:join, socket, person}, _from, state) do
    if map_size(state.sockets) < @max_streams and
         (MapSet.member?(state.people, person) or
            MapSet.size(state.people) < Reducer.max_participants()) do
      ref = Process.monitor(socket)
      sockets = Map.put(state.sockets, ref, {socket, person})

      next = %{
        state
        | sockets: sockets,
          people: MapSet.put(state.people, person),
          admitted_at: Map.put(state.admitted_at, person, System.monotonic_time(:millisecond))
      }

      snapshot = snapshot(next)
      Enum.each(snapshot, &send(socket, {:whiteboard_v1_frame, &1}))

      {:reply, {:ok, self(), state.id, snapshot}, next}
    else
      {:reply, {:error, :overloaded}, state}
    end
  end

  def handle_call({:view, socket, frame, input}, _from, state) do
    person = frame["participant_id"]

    if Enum.any?(state.sockets, fn {_ref, member} -> member == {socket, person} end) do
      input = Map.put(input, :socket_id, socket)
      stream = {person, relay_stream(input)}

      if MapSet.member?(state.admitted, stream) or MapSet.size(state.admitted) < @max_streams do
        {reply, next} = accept(state, frame, input)
        {:reply, reply, %{next | admitted: MapSet.put(next.admitted, stream)}}
      else
        {:reply, {:error, :overloaded}, state}
      end
    else
      {:reply, {:error, :permission_denied}, state}
    end
  end

  defp snapshot(state) do
    roster = Authority.active_people(state.episode)

    state.views
    |> Enum.filter(fn {person, _view} -> active_view?(state, person, roster) end)
    |> Enum.map(fn {_person, view} -> %{view | "bring" => false} end)
  end

  defp active_view?(_state, _person, nil), do: true

  defp active_view?(state, person, {active, read_at}) do
    MapSet.member?(active, String.downcase(person)) or
      Map.fetch!(state.admitted_at, person) >= read_at
  end

  @impl true
  def handle_info({:DOWN, ref, :process, _pid, _reason}, state) do
    sockets = Map.delete(state.sockets, ref)

    # Retire disconnected identities from admission, but retain bounded retry receipts.
    people = MapSet.new(sockets, fn {_ref, {_socket, person}} -> person end)
    admitted_at = Map.take(state.admitted_at, Map.keys(state.views) ++ MapSet.to_list(people))
    next = %{state | sockets: sockets, people: people, admitted_at: admitted_at}

    if map_size(sockets) == 0,
      do: {:stop, :normal, next},
      else: {:noreply, next}
  end

  defp accept(state, %{"bring" => false} = frame, %{move: false} = input),
    do: apply_view(state, frame, input)

  defp accept(state, frame, input) do
    case input_id(input) do
      {:ok, stream, sequence} ->
        stream = {frame["participant_id"], stream}
        previous = Map.get(state.streams, stream, 0)

        if sequence <= previous do
          {:ok, state}
        else
          state = %{state | streams: Map.put(state.streams, stream, sequence)}
          apply_view(state, frame, input)
        end

      :legacy ->
        accept_legacy(state, frame, input)
    end
  end

  defp accept_relay(state, frame, input) do
    source = Map.get(state.views, input.origin_participant_id)
    stream = {frame["participant_id"], relay_stream(input)}
    previous = Map.get(state.relays, stream)
    version = if source, do: {input.origin_participant_id, source["owner_sequence"]}
    publisher = Map.get(state.publishers, frame["participant_id"], elem(stream, 1))

    cond do
      publisher != elem(stream, 1) && !Map.get(input, :move, false) ->
        {:ok, state}

      is_nil(version) or (version == previous and not Map.get(input, :move, false)) ->
        {:ok, state}

      true ->
        stamp_view(%{state | relays: Map.put(state.relays, stream, version)}, frame, input)
    end
  end

  defp relay_stream(input) do
    case input_id(input) do
      {:ok, stream, _sequence} -> stream
      :legacy -> Map.get(input, :origin_epoch, input.socket_id)
    end
  end

  defp accept_legacy(state, frame, input) do
    person = frame["participant_id"]

    if Map.get(input, :origin_participant_id, person) != person do
      apply_view(state, frame, input)
    else
      stream = {person, Map.get(input, :origin_epoch, input.socket_id)}
      rectangle = Map.take(frame, ~w(x y width height))
      sequence = Map.get(input, :origin_sequence, 0)
      {previous, watermark} = Map.get(state.legacy_views, stream, {nil, 0})

      if not frame["bring"] and
           (previous == rectangle or (sequence > 0 and sequence <= watermark)) do
        {:ok, state}
      else
        legacy = Map.put(state.legacy_views, stream, {rectangle, max(sequence, watermark)})
        apply_view(%{state | legacy_views: legacy}, frame, input)
      end
    end
  end

  defp input_id(%{input_id: id}) do
    [stream, sequence] = String.split(id, ":")
    {:ok, String.downcase(stream), String.to_integer(sequence)}
  end

  defp input_id(_input), do: :legacy

  defp apply_view(
         state,
         %{"participant_id" => person, "bring" => false} = frame,
         %{
           origin_participant_id: origin
         } = input
       )
       when origin != person,
       do: accept_relay(state, frame, input)

  defp apply_view(state, frame, input), do: stamp_view(state, frame, input)

  defp stamp_view(state, frame, input) do
    person = frame["participant_id"]
    previous = Map.get(state.views, person)
    candidate = canonical_rectangle(frame, input, state.views)

    state =
      if candidate && (is_nil(previous) || Map.get(input, :move, true)),
        do: %{state | publishers: Map.put(state.publishers, person, relay_stream(input))},
        else: state

    if candidate && (frame["bring"] || changed?(previous, candidate)) do
      sequence = if previous, do: previous["owner_sequence"] + 1, else: 1
      canonical = Map.merge(candidate, %{"owner_id" => state.id, "owner_sequence" => sequence})

      Enum.each(state.sockets, fn {_ref, {socket, _}} ->
        send(socket, {:whiteboard_v1_frame, canonical})
      end)

      {:ok, %{state | views: Map.put(state.views, person, canonical)}}
    else
      {:ok, state}
    end
  end

  defp canonical_rectangle(frame, input, views) do
    person = frame["participant_id"]
    origin = Map.get(input, :origin_participant_id, person)

    cond do
      frame["bring"] -> frame
      origin != person -> relay_rectangle(Map.get(views, origin), frame)
      Map.get(input, :move, true) -> frame
      Map.has_key?(views, person) -> nil
      true -> frame
    end
  end

  defp relay_rectangle(nil, _frame), do: nil

  defp relay_rectangle(source, frame),
    do: Map.merge(frame, Map.take(source, ~w(x y width height)))

  defp changed?(nil, _view), do: true

  defp changed?(left, right),
    do: Map.take(left, ~w(x y width height)) != Map.take(right, ~w(x y width height))
end
