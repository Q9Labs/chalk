defmodule ChalkSync.SyncBreaker.RandomWireCampaign do
  @moduledoc false

  alias ChalkSync.DevTools
  alias ChalkSync.Rooms.Room
  alias ChalkSync.Rooms.RoomServer
  alias ChalkSync.Stateholder
  alias ChalkSync.SyncBreaker.Model
  alias ChalkSync.SyncBreaker.Result
  alias ChalkSync.SyncBreaker.WireActor

  def run_case(port, seed, options \\ []) do
    Task.async(fn -> run_isolated_case(port, seed, options) end)
    |> Task.await(:infinity)
  end

  defp run_isolated_case(port, seed, options) do
    participant_count = Keyword.get(options, :participants, 4)
    step_count = Keyword.get(options, :steps, 100)
    room_id = "breaker-random-#{seed}-#{System.unique_integer([:positive])}"
    random_state = :rand.seed_s(:exsplus, random_seed(seed))

    try do
      with {:ok, actors, trace} <- connect_actors(port, room_id, participant_count),
           {:ok, actors, trace} <- settle_and_check(room_id, actors, trace),
           {:ok, state} <-
             run_steps(%{
               port: port,
               room_id: room_id,
               actors: actors,
               commands: %{},
               next_command: 1,
               allow_retries: Keyword.get(options, :retries, true),
               allow_writer_restarts: Keyword.get(options, :writer_restarts, true),
               random_state: random_state,
               trace: trace,
               steps: step_count
             }) do
        close_actors(state.actors)

        Result.pass("random_wire",
          seed: seed,
          evidence: final_evidence(state),
          trace: state.trace
        )
      else
        {:error, invariant, message, evidence, trace} ->
          Result.fail("random_wire", invariant, message,
            seed: seed,
            evidence: Map.put(evidence, "room_id", room_id),
            trace: trace
          )

        {:error, reason} ->
          Result.fail("random_wire", :campaign_execution, inspect(reason),
            seed: seed,
            evidence: %{"reason" => inspect(reason), "room_id" => room_id}
          )
      end
    rescue
      exception ->
        Result.error("random_wire", exception,
          seed: seed,
          stacktrace: __STACKTRACE__,
          evidence: %{"room_id" => room_id}
        )
    after
      cleanup_room(room_id)
    end
  end

  defp connect_actors(port, room_id, participant_count) do
    Enum.reduce_while(1..participant_count, {:ok, %{}, []}, fn index, {:ok, actors, trace} ->
      participant_id = "participant-#{index}"
      actor = WireActor.new("tenant-1", room_id, participant_id, "Participant #{index}")

      case WireActor.connect(actor, port) do
        {:ok, actor, welcome} ->
          trace =
            trace ++ [%{"action" => "connect", "actor" => participant_id, "frame" => welcome}]

          {:cont, {:ok, Map.put(actors, participant_id, actor), trace}}

        error ->
          {:halt, {:error, :connect, inspect(error), %{"actor" => participant_id}, trace}}
      end
    end)
  end

  defp run_steps(%{steps: 0} = state), do: {:ok, state}

  defp run_steps(state) do
    {choice, random_state} = random_integer(state.random_state, 100)
    state = %{state | random_state: random_state, steps: state.steps - 1}

    result =
      cond do
        choice <= 55 -> run_command(state)
        choice <= 75 -> run_concurrent_commands(state)
        choice <= 92 -> run_reconnect(state)
        state.allow_writer_restarts -> run_writer_restart(state)
        true -> run_reconnect(state)
      end

    case result do
      {:ok, state} -> run_steps(state)
      error -> error
    end
  end

  defp run_command(state) do
    {participant_id, state} = random_actor(state)
    {command_name, state} = random_command_name(state)
    {command_id, state} = command_id(state, participant_id, command_name)

    actor = state.actors[participant_id]
    before_revision = WireActor.revision(actor)
    before_frame_count = length(actor.frames)
    actor = WireActor.send_command(actor, command_id, command_name)

    case WireActor.await_ack(actor, command_id) do
      {:ok, actor, ack} ->
        state = put_in(state.actors[participant_id], actor)
        trace = state.trace ++ [command_trace(participant_id, command_id, command_name, ack)]
        state = %{state | trace: trace}

        with :ok <- ensure_stable_ack(state.commands, participant_id, command_id, ack),
             state <- remember_ack(state, participant_id, command_id, command_name, ack),
             {:ok, actors, trace} <-
               settle_and_check(state.room_id, state.actors, state.trace) do
          finish_sequential_command(
            %{state | actors: actors, trace: trace},
            participant_id,
            command_name,
            ack,
            before_revision,
            before_frame_count
          )
        else
          {:error, {:idempotency, reason}} ->
            failure(state, :idempotency, reason, %{
              "actor" => participant_id,
              "command_id" => command_id,
              "ack" => ack
            })

          error ->
            error
        end

      error ->
        failure(state, :command_acknowledgement, inspect(error), %{
          "actor" => participant_id,
          "command_id" => command_id
        })
    end
  end

  defp run_concurrent_commands(state) do
    {:ok, room_before} = Stateholder.load(state.room_id)
    {actor_ids, random_state} = random_actor_pair(Map.keys(state.actors), state.random_state)
    state = %{state | random_state: random_state}

    {state, pending} =
      Enum.reduce(actor_ids, {state, []}, fn participant_id, {state, pending} ->
        {command_name, state} = random_command_name(state)
        command_id = "command-#{state.next_command}"
        actor = state.actors[participant_id]
        actor = WireActor.send_command(actor, command_id, command_name)

        state = %{
          put_in(state.actors[participant_id], actor)
          | next_command: state.next_command + 1
        }

        {state, pending ++ [{participant_id, command_id, command_name}]}
      end)

    Enum.reduce_while(pending, {:ok, state, []}, fn {participant_id, command_id, command_name},
                                                    {:ok, state, observations} ->
      case WireActor.await_ack(state.actors[participant_id], command_id) do
        {:ok, actor, ack} ->
          state = put_in(state.actors[participant_id], actor)
          state = remember_ack(state, participant_id, command_id, command_name, ack)
          trace = state.trace ++ [command_trace(participant_id, command_id, command_name, ack)]

          observation = %{participant_id: participant_id, command_name: command_name, ack: ack}
          {:cont, {:ok, %{state | trace: trace}, observations ++ [observation]}}

        error ->
          {:halt,
           failure(state, :concurrent_acknowledgement, inspect(error), %{
             "actor" => participant_id,
             "command_id" => command_id
           })}
      end
    end)
    |> finish_concurrent_commands(room_before.revision)
  end

  defp finish_concurrent_commands({:ok, state, observations}, base_revision) do
    case settle_and_check(state.room_id, state.actors, state.trace) do
      {:ok, actors, trace} ->
        state = %{state | actors: actors, trace: trace}
        validate_settled_concurrency(state, observations, base_revision)

      error ->
        error
    end
  end

  defp finish_concurrent_commands(error, _base_revision), do: error

  defp validate_settled_concurrency(state, observations, base_revision) do
    case validate_concurrent_observations(
           state.room_id,
           state.actors,
           base_revision,
           observations
         ) do
      :ok ->
        {:ok, state}

      {:error, reason} ->
        failure(state, :ack_event_correlation, reason, %{
          "base_revision" => base_revision,
          "observations" => observations
        })
    end
  end

  defp run_reconnect(state) do
    {participant_id, state} = random_actor(state)
    actor = state.actors[participant_id]
    cursor = WireActor.revision(actor)
    actor = WireActor.close_tcp(actor)
    state = put_in(state.actors[participant_id], actor)

    with :ok <- await_participant_absent(state.room_id, participant_id, 2_000),
         {:ok, actor, welcome} <- WireActor.connect(actor, state.port, cursor),
         actors <- Map.put(state.actors, participant_id, actor),
         trace <-
           state.trace ++
             [
               %{
                 "action" => "reconnect",
                 "actor" => participant_id,
                 "cursor" => cursor,
                 "frame" => welcome
               }
             ],
         {:ok, actors, trace} <- settle_and_check(state.room_id, actors, trace) do
      {:ok, %{state | actors: actors, trace: trace}}
    else
      error ->
        failure(state, :reconnect_convergence, inspect(error), %{
          "actor" => participant_id,
          "cursor" => cursor
        })
    end
  end

  defp run_writer_restart(state) do
    cursors = Map.new(state.actors, fn {id, actor} -> {id, WireActor.revision(actor)} end)

    with :ok <- DevTools.restart_room(state.room_id),
         {:ok, actors, trace} <- reconnect_after_restart(state, cursors),
         {:ok, actors, trace} <- settle_and_check(state.room_id, actors, trace) do
      {:ok, %{state | actors: actors, trace: trace}}
    else
      error ->
        failure(state, :writer_restart_convergence, inspect(error), %{"cursors" => cursors})
    end
  end

  defp reconnect_after_restart(state, cursors) do
    Enum.reduce_while(state.actors, {:ok, %{}, state.trace}, fn {id, actor},
                                                                {:ok, actors, trace} ->
      case WireActor.connect(%{actor | connected: false}, state.port, cursors[id]) do
        {:ok, actor, welcome} ->
          entry = %{"action" => "writer_restart_reconnect", "actor" => id, "frame" => welcome}
          {:cont, {:ok, Map.put(actors, id, actor), trace ++ [entry]}}

        error ->
          {:halt, {:error, {:restart_reconnect, id, error}}}
      end
    end)
  end

  defp settle_and_check(room_id, actors, trace) do
    with {:ok, room} <- Stateholder.load(room_id),
         target_revision <- room.revision,
         {:ok, actors, trace} <- settle_actors(actors, target_revision, trace),
         :ok <- compare_replicas(room, actors) do
      {:ok, actors, trace}
    else
      {:error, reason, evidence, trace} ->
        {:error, :replica_convergence, inspect(reason), evidence, trace}

      other ->
        {:error, :authoritative_state, inspect(other), %{"room_id" => room_id}, trace}
    end
  end

  defp settle_actors(actors, revision, trace) do
    Enum.reduce_while(actors, {:ok, %{}, trace}, fn {id, actor}, {:ok, settled, trace} ->
      case WireActor.await_revision(actor, revision) do
        {:ok, actor, observed} ->
          entry = %{
            "action" => "settle",
            "actor" => id,
            "revision" => revision,
            "frames" => observed
          }

          {:cont, {:ok, Map.put(settled, id, actor), trace ++ [entry]}}

        {:error, reason, observed} ->
          {:halt,
           {:error, reason, %{"actor" => id, "target_revision" => revision, "frames" => observed},
            trace}}
      end
    end)
  end

  defp compare_replicas(room, actors) do
    snapshot = Room.snapshot(room)

    case Enum.find(actors, fn {_id, actor} ->
           not Model.snapshot_matches?(actor.model, snapshot)
         end) do
      nil -> :ok
      {id, actor} -> {:error, {:replica_mismatch, id, Model.snapshot(actor.model), snapshot}}
    end
  end

  defp await_participant_absent(room_id, participant_id, timeout) do
    deadline = System.monotonic_time(:millisecond) + timeout
    await_participant_absent_until(room_id, participant_id, deadline)
  end

  defp await_participant_absent_until(room_id, participant_id, deadline) do
    case Stateholder.load(room_id) do
      {:ok, room} ->
        await_participant_state(room, room_id, participant_id, deadline)

      other ->
        {:error, {:stateholder_load, other}}
    end
  end

  defp await_participant_state(room, room_id, participant_id, deadline) do
    cond do
      not Map.has_key?(room.participants, participant_id) ->
        :ok

      System.monotonic_time(:millisecond) >= deadline ->
        {:error, :participant_leave_timeout}

      true ->
        receive do
        after
          1 -> await_participant_absent_until(room_id, participant_id, deadline)
        end
    end
  end

  defp command_id(state, participant_id, command_name) do
    {retry_choice, random_state} = random_integer(state.random_state, 10)
    state = %{state | random_state: random_state}

    previous =
      state.commands
      |> Enum.filter(fn {{actor, _id}, command} ->
        actor == participant_id and command.name == command_name
      end)
      |> Enum.map(fn {{_actor, id}, _command} -> id end)

    if state.allow_retries and retry_choice == 1 and previous != [] do
      {command_id, random_state} = random_member(previous, state.random_state)
      {command_id, %{state | random_state: random_state}}
    else
      command_id = "command-#{state.next_command}"
      {command_id, %{state | next_command: state.next_command + 1}}
    end
  end

  defp validate_ack(commands, participant_id, command_id, ack) do
    case commands do
      %{{^participant_id, ^command_id} => %{ack: original}} ->
        cond do
          original["result"] == "committed" and
              ack == %{
                "type" => "ack",
                "command_id" => command_id,
                "result" => "duplicate",
                "revision" => original["revision"]
              } ->
            :ok

          original["result"] == "rejected" and ack["result"] == "rejected" and
              ack["reason"] == original["reason"] ->
            :ok

          true ->
            {:error, {:retry_changed_outcome, original, ack}}
        end

      _ ->
        :ok
    end
  end

  defp ensure_stable_ack(commands, participant_id, command_id, ack) do
    case validate_ack(commands, participant_id, command_id, ack) do
      :ok -> :ok
      {:error, reason} -> {:error, {:idempotency, reason}}
    end
  end

  defp finish_sequential_command(
         state,
         participant_id,
         command_name,
         ack,
         before_revision,
         before_frame_count
       ) do
    case validate_command_observation(
           state.actors[participant_id],
           participant_id,
           command_name,
           ack,
           before_revision,
           before_frame_count
         ) do
      :ok ->
        {:ok, state}

      {:error, {:command_effect, reason}} ->
        failure(state, :ack_event_correlation, reason, %{
          "actor" => participant_id,
          "command_id" => ack["command_id"],
          "ack" => ack
        })
    end
  end

  defp validate_command_observation(
         actor,
         participant_id,
         command_name,
         ack,
         before_revision,
         before_frame_count
       ) do
    events =
      actor.frames |> Enum.drop(before_frame_count) |> Enum.filter(&(&1["type"] == "event"))

    valid? =
      case ack do
        %{"result" => "committed", "revision" => revision} ->
          WireActor.revision(actor) == revision and
            events == [expected_event(events, participant_id, command_name, revision)]

        %{"result" => result} when result in ["duplicate", "rejected"] ->
          WireActor.revision(actor) == before_revision and events == []

        _ ->
          false
      end

    if valid?,
      do: :ok,
      else: {:error, {:command_effect, {:unexpected_ack_events, ack, events, before_revision}}}
  end

  defp expected_event([event], participant_id, command_name, revision) do
    if event["revision"] == revision and event["name"] == event_name(command_name) and
         get_in(event, ["payload", "participant_id"]) == participant_id,
       do: event,
       else: nil
  end

  defp expected_event(_events, _participant_id, _command_name, _revision), do: nil

  defp validate_concurrent_observations(room_id, actors, base_revision, observations) do
    {:ok, room} = Stateholder.load(room_id)

    events =
      actors
      |> Map.values()
      |> hd()
      |> Map.fetch!(:frames)
      |> Enum.filter(&(&1["type"] == "event" and &1["revision"] > base_revision))

    committed = Enum.filter(observations, &(&1.ack["result"] == "committed"))

    valid? =
      room.revision == base_revision + length(committed) and
        length(events) == length(committed) and
        Enum.all?(observations, &observation_matches_events?(&1, events))

    if valid?,
      do: :ok,
      else: {:error, {:unexpected_concurrent_effects, observations, events, room.revision}}
  end

  defp observation_matches_events?(
         %{ack: %{"result" => "committed", "revision" => revision}} = o,
         events
       ) do
    Enum.count(events, fn event ->
      event["revision"] == revision and event["name"] == event_name(o.command_name) and
        get_in(event, ["payload", "participant_id"]) == o.participant_id
    end) == 1
  end

  defp observation_matches_events?(observation, events) do
    Enum.all?(events, fn event ->
      event["name"] != event_name(observation.command_name) or
        get_in(event, ["payload", "participant_id"]) != observation.participant_id
    end)
  end

  defp event_name(:raise_hand), do: "hand_raised"
  defp event_name(:lower_hand), do: "hand_lowered"

  defp remember_ack(state, participant_id, command_id, command_name, ack) do
    key = {participant_id, command_id}

    if Map.has_key?(state.commands, key) do
      state
    else
      put_in(state.commands[key], %{name: command_name, ack: ack})
    end
  end

  defp random_actor(state) do
    {actor, random_state} = random_member(Map.keys(state.actors), state.random_state)
    {actor, %{state | random_state: random_state}}
  end

  defp random_command_name(state) do
    {name, random_state} = random_member([:raise_hand, :lower_hand], state.random_state)
    {name, %{state | random_state: random_state}}
  end

  defp random_actor_pair(actors, random_state) do
    {first, random_state} = random_member(actors, random_state)
    remaining = Enum.reject(actors, &(&1 == first))

    if remaining == [] do
      {[first], random_state}
    else
      {second, random_state} = random_member(remaining, random_state)
      {[first, second], random_state}
    end
  end

  defp random_member(items, random_state) do
    {index, random_state} = random_integer(random_state, length(items))
    {Enum.at(items, index - 1), random_state}
  end

  defp random_integer(random_state, maximum), do: :rand.uniform_s(maximum, random_state)

  defp random_seed(seed) do
    value = seed + 1
    {value, value * 19 + 11, value * 37 + 17}
  end

  defp command_trace(participant_id, command_id, command_name, ack) do
    %{
      "action" => "command",
      "actor" => participant_id,
      "command_id" => command_id,
      "name" => Atom.to_string(command_name),
      "ack" => ack
    }
  end

  defp failure(state, invariant, message, evidence) do
    {:error, invariant, message, evidence, state.trace}
  end

  defp final_evidence(state) do
    {:ok, room} = Stateholder.load(state.room_id)

    %{
      "room_id" => state.room_id,
      "final_revision" => room.revision,
      "participants" => map_size(room.participants),
      "commands" => map_size(state.commands)
    }
  end

  defp close_actors(actors) do
    Enum.each(actors, fn {_id, actor} ->
      if actor.connected, do: WireActor.close_tcp(actor)
    end)
  end

  defp cleanup_room(room_id), do: cleanup_room(room_id, 50)

  defp cleanup_room(_room_id, 0), do: :ok

  defp cleanup_room(room_id, attempts) do
    case RoomServer.whereis(room_id) do
      nil ->
        :ok

      writer ->
        DynamicSupervisor.terminate_child(ChalkSync.Rooms.Supervisor, writer)

        receive do
        after
          1 -> cleanup_room(room_id, attempts - 1)
        end
    end
  end
end
