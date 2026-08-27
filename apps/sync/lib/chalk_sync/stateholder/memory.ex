defmodule ChalkSync.Stateholder.Memory do
  @moduledoc """
  ETS-backed stateholder adapter for single-node dev and test.

  All writes serialize through this GenServer so compare-and-set commits are
  atomic even if a second (buggy) writer appears. Reads go straight to ETS.
  """

  @behaviour ChalkSync.Stateholder

  use GenServer

  @episodes __MODULE__.Episodes
  @internal_operations [
    :admission_request_expired,
    :tenant_set_deadline,
    :tenant_end_episode,
    :maximum_duration_expired,
    :start_recording,
    :recording_capture_ready,
    :recording_capture_stopped
  ]

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.ProtocolV1
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.UUID

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl ChalkSync.Stateholder
  def decide_command(%Identity{} = identity, %Command{} = command) do
    GenServer.call(__MODULE__, {:decide_command, identity, command})
  end

  @impl ChalkSync.Stateholder
  def resolve_receipt(%Identity{} = identity, %Command{} = command) do
    GenServer.call(__MODULE__, {:resolve_receipt, identity, command})
  end

  @impl ChalkSync.Stateholder
  def recover(%Identity{} = identity, cursor) do
    GenServer.call(__MODULE__, {:recover, identity, cursor})
  end

  @doc false
  def recover(%EpisodeKey{} = episode, cursor),
    do: GenServer.call(__MODULE__, {:recover_episode, episode, cursor})

  @impl ChalkSync.Stateholder
  def recover_episode(%EpisodeKey{} = episode, cursor), do: recover(episode, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%EpisodeKey{} = episode, after_revision, through_revision) do
    GenServer.call(
      __MODULE__,
      {:recovery_page, episode, after_revision, through_revision}
    )
  end

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(%EpisodeKey{} = episode, lifecycle_intent_id),
    do: GenServer.call(__MODULE__, {:apply_lifecycle_intent, episode, lifecycle_intent_id})

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(_episode, _lifecycle_intent_id, _reason), do: :ok

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(_limit), do: {:ok, []}

  @impl ChalkSync.Stateholder
  def begin_operation(%Identity{} = identity, %Operation{} = operation),
    do: GenServer.call(__MODULE__, {:begin_operation, identity, operation})

  @impl ChalkSync.Stateholder
  def begin_internal_operation(%EpisodeKey{} = episode, %Operation{} = operation),
    do: GenServer.call(__MODULE__, {:begin_internal_operation, episode, operation})

  @impl ChalkSync.Stateholder
  def claim_operations(limit), do: GenServer.call(__MODULE__, {:claim_operations, limit})

  @impl ChalkSync.Stateholder
  def claim_local_operations(limit),
    do: GenServer.call(__MODULE__, {:claim_local_operations, limit})

  @impl ChalkSync.Stateholder
  def read_operation(%EpisodeKey{} = episode, external_operation_id),
    do: GenServer.call(__MODULE__, {:read_operation, episode, external_operation_id})

  @impl ChalkSync.Stateholder
  def finalize_operation(%EpisodeKey{} = episode, external_operation_id, outcome),
    do: GenServer.call(__MODULE__, {:finalize_operation, episode, external_operation_id, outcome})

  @impl ChalkSync.Stateholder
  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation),
    do:
      GenServer.call(
        __MODULE__,
        {:participant_authority, episode, participant_id, expected_generation}
      )

  @impl ChalkSync.Stateholder
  def reserve_publication_grant(_identity, _operation_id, _source),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def complete_publication_grant(_episode, _reservation_id, _outcome),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def begin_role_transition(identity, command, _publications),
    do: decide_command(identity, command)

  @doc "Seeds one deterministic Episode for adapter conformance tests."
  def seed_episode(%EpisodeKey{} = episode, participants \\ []) when is_list(participants) do
    GenServer.call(__MODULE__, {:seed_episode, episode, participants})
  end

  @doc false
  def seed_admission_request(%EpisodeKey{} = episode, payload),
    do: GenServer.call(__MODULE__, {:seed_admission_request, episode, payload})

  @doc "Test helper: drops all in-memory episode state."
  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  @impl GenServer
  def init(_opts) do
    :ets.new(@episodes, [:named_table, :protected, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call(:reset, _from, s) do
    :ets.delete_all_objects(@episodes)
    {:reply, :ok, s}
  end

  def handle_call({:seed_episode, episode, participants}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(episode)

    if :ets.member(@episodes, authority_key) do
      {:reply, {:error, :already_exists}, server_state}
    else
      case seeded_episode(episode, participants) do
        {:ok, state} ->
          :ets.insert(@episodes, {authority_key, state})
          {:reply, :ok, server_state}

        {:error, reason} ->
          {:reply, {:error, reason}, server_state}
      end
    end
  end

  def handle_call({:seed_admission_request, episode_key, payload}, _from, server_state) do
    key = EpisodeKey.authority_key(episode_key)

    case :ets.lookup(@episodes, key) do
      [{^key, episode}] ->
        case Reducer.apply_lifecycle(episode.state, :admission_requested, payload) do
          {:ok, event, state} ->
            next = %{
              episode
              | state: state,
                events: :queue.in(memory_event(event, nil, nil, state), episode.events)
            }

            :ets.insert(@episodes, {key, next})
            {:reply, :ok, server_state}

          error ->
            {:reply, error, server_state}
        end

      [] ->
        {:reply, {:error, :episode_not_found}, server_state}
    end
  end

  def handle_call(
        {:participant_authority, episode_key, participant_id, expected_generation},
        _from,
        server_state
      ) do
    key = EpisodeKey.authority_key(episode_key)
    participant_id = normalize_id(participant_id)

    reply =
      case :ets.lookup(@episodes, key) do
        [{^key, %{state: %{status: "active"}} = episode}] ->
          memory_participant_authority(episode, participant_id, expected_generation)

        [{^key, _episode}] ->
          {:error, :episode_ended}

        [] ->
          {:error, :episode_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:decide_command, identity, command}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(identity.episode)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] -> decide(episode, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    case reply do
      {:ok, decision, episode} ->
        :ets.insert(@episodes, {authority_key, episode})
        {:reply, {:ok, decision}, server_state}

      other ->
        {:reply, other, server_state}
    end
  end

  def handle_call({:begin_operation, identity, operation}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(identity.episode)

    case :ets.lookup(@episodes, authority_key) do
      [{^authority_key, episode}] ->
        case begin_memory_operation(episode, identity, operation) do
          {:ok, decision, next} ->
            :ets.insert(@episodes, {authority_key, next})
            {:reply, {:ok, decision}, server_state}

          {:ok, decision} ->
            {:reply, {:ok, decision}, server_state}
        end

      [] ->
        {:reply, {:retryable, :dependency_unavailable}, server_state}
    end
  end

  def handle_call({:begin_internal_operation, episode_key, operation}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(episode_key)

    case :ets.lookup(@episodes, authority_key) do
      [{^authority_key, episode}] ->
        case begin_memory_internal_operation(episode, operation) do
          {:ok, decision, next} ->
            :ets.insert(@episodes, {authority_key, next})
            {:reply, {:ok, decision}, server_state}

          other ->
            {:reply, other, server_state}
        end

      [] ->
        {:reply, {:error, :episode_not_found}, server_state}
    end
  end

  def handle_call({:claim_operations, limit}, _from, server_state),
    do: claim_memory_operations(server_state, limit, fn _operation -> true end)

  def handle_call({:claim_local_operations, limit}, _from, server_state) do
    claim_memory_operations(server_state, limit, fn operation ->
      operation.name in [
        :participant_leave,
        :end_episode,
        :tenant_end_episode,
        :maximum_duration_expired,
        :recording_capture_ready,
        :recording_capture_stopped
      ]
    end)
  end

  def handle_call({:read_operation, episode_key, external_operation_id}, _from, server_state) do
    key = EpisodeKey.authority_key(episode_key)

    reply =
      with [{^key, episode}] <- :ets.lookup(@episodes, key),
           %{^external_operation_id => operation} <- episode.operations do
        {:ok, operation}
      else
        _ -> :not_found
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:finalize_operation, episode_key, external_operation_id, outcome},
        _from,
        server_state
      ) do
    key = EpisodeKey.authority_key(episode_key)

    case :ets.lookup(@episodes, key) do
      [{^key, episode}] ->
        case finalize_memory_operation(episode, external_operation_id, outcome) do
          {:ok, decision, next} ->
            :ets.insert(@episodes, {key, next})
            {:reply, {:ok, decision}, server_state}

          error ->
            {:reply, error, server_state}
        end

      [] ->
        {:reply, {:error, :episode_not_found}, server_state}
    end
  end

  def handle_call({:resolve_receipt, identity, command}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(identity.episode)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] -> receipt_decision(episode, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover, identity, cursor}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(identity.episode)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] -> recover_identity(episode, identity, cursor)
        [] -> {:error, :episode_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover_episode, episode_key, cursor}, _from, server_state) do
    authority_key = EpisodeKey.authority_key(episode_key)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] -> {:ok, recovery(episode, cursor)}
        [] -> {:error, :episode_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:recovery_page, episode_key, after_revision, through_revision},
        _from,
        server_state
      ) do
    authority_key = EpisodeKey.authority_key(episode_key)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] ->
          events =
            episode.events
            |> :queue.to_list()
            |> Enum.filter(&(&1.revision > after_revision and &1.revision <= through_revision))
            |> bounded_recovery_page()

          {:ok, events}

        [] ->
          {:error, :episode_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:apply_lifecycle_intent, episode_key, lifecycle_intent_id},
        _from,
        server_state
      ) do
    authority_key = EpisodeKey.authority_key(episode_key)

    reply =
      case :ets.lookup(@episodes, authority_key) do
        [{^authority_key, episode}] ->
          lifecycle_decision(episode, lifecycle_intent_id)

        [] ->
          {:error, :episode_not_found}
      end

    {:reply, reply, server_state}
  end

  defp claim_memory_operations(server_state, limit, operation_filter) do
    operations =
      @episodes
      |> :ets.tab2list()
      |> Enum.flat_map(fn {_key, episode} ->
        episode.operations
        |> Map.values()
        |> Enum.filter(&(&1.status == :pending and operation_filter.(&1)))
        |> Enum.map(&{episode.episode, &1})
      end)
      |> Enum.sort_by(fn {_episode, operation} -> operation.external_operation_id end)
      |> Enum.take(limit)

    {:reply, {:ok, operations}, server_state}
  end

  defp lifecycle_decision(episode, lifecycle_intent_id) do
    lifecycle_intent_id = normalize_id(lifecycle_intent_id)

    if lifecycle_intent_applied?(episode, lifecycle_intent_id) do
      {:ok,
       %LifecycleDecision{
         lifecycle_intent_id: lifecycle_intent_id,
         result: :already_applied
       }}
    else
      {:error, :lifecycle_intent_not_found}
    end
  end

  defp lifecycle_intent_applied?(episode, lifecycle_intent_id) do
    Enum.any?(episode.participants, fn {_id, participant} ->
      participant.admission_lifecycle_intent_id == lifecycle_intent_id and
        participant.status == :active
    end)
  end

  defp seeded_episode(episode_key, participants) do
    initial = %{
      episode: episode_key,
      state: Reducer.new(episode_key.episode_id),
      participants: %{},
      receipts: %{},
      operations: %{},
      recording_capture_epochs: %{},
      events: :queue.new()
    }

    Enum.reduce_while(participants, {:ok, initial}, fn participant, {:ok, episode} ->
      case seed_participant(episode, participant) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp seed_participant(episode, participant) do
    with %{id: raw_id, generation: generation, display_name: display_name} <- participant,
         id = normalize_id(raw_id),
         true <- is_binary(id) and is_integer(generation) and generation > 0,
         role =
           Map.get(
             participant,
             :role,
             if(map_size(episode.participants) == 0, do: "owner", else: "observer")
           ),
         {:ok, event, state} <-
           Reducer.apply_lifecycle(episode.state, :participant_joined, %{
             "participant_id" => id,
             "display_name" => display_name,
             "role" => role,
             "admission_revision" => episode.state.revision + 1
           }) do
      product = %{
        generation: generation,
        status: :active,
        role: role,
        admission_lifecycle_intent_id:
          participant |> Map.get(:admission_lifecycle_intent_id) |> normalize_id()
      }

      next = %{
        episode
        | state: state,
          participants: Map.put(episode.participants, id, product),
          events: :queue.in(memory_event(event, nil, nil, state), episode.events)
      }

      {:ok, next}
    else
      _ -> {:error, :invalid_participant}
    end
  end

  defp decide(episode, identity, command) do
    case receipt_decision(episode, identity, command) do
      {:ok, decision} -> {:ok, decision, episode}
      :not_found -> decide_new(episode, identity, command)
    end
  end

  defp decide_new(episode, identity, command) do
    with {:ok, participant} <- active_participant(episode, identity),
         :ok <- capability(episode, identity, participant, command.name) do
      persist_reducer_decision(episode, identity, command)
    else
      {:error, reason} -> persist_rejection(episode, identity, command, reason)
    end
  end

  defp persist_reducer_decision(episode, identity, command) do
    case Reducer.decide_command(
           episode.state,
           normalize_id(identity.participant_id),
           command.name,
           command.payload
         ) do
      {:change, event, state} -> persist_commit(episode, identity, command, event, state)
      {:satisfied, state} -> persist_satisfied(episode, identity, command, state)
      {:error, reason} -> persist_rejection(episode, identity, command, normalize_reason(reason))
    end
  end

  defp begin_memory_operation(episode, identity, operation) do
    existing =
      Enum.find(Map.values(episode.operations), fn candidate ->
        candidate.name == operation.name and candidate.request_key == operation.request_key
      end)

    cond do
      existing && existing.request_fingerprint != operation.fingerprint ->
        {:ok,
         %OperationDecision{
           request_key: operation.request_key,
           result: :command_id_conflict,
           reason: :command_id_conflict
         }}

      existing ->
        {:ok, operation_decision(existing, :duplicate)}

      true ->
        begin_new_memory_operation(episode, identity, operation)
    end
  end

  defp begin_memory_internal_operation(episode, operation) do
    existing =
      Enum.find(Map.values(episode.operations), fn candidate ->
        candidate.name == operation.name and candidate.request_key == operation.request_key
      end)

    cond do
      existing && existing.request_fingerprint != operation.fingerprint ->
        {:ok,
         %OperationDecision{
           request_key: operation.request_key,
           result: :command_id_conflict,
           reason: :command_id_conflict
         }, episode}

      existing ->
        {:ok, operation_decision(existing, :duplicate), episode}

      operation.name in @internal_operations ->
        begin_new_memory_internal_operation(episode, operation)

      true ->
        {:error, :invalid_internal_operation}
    end
  end

  defp begin_new_memory_internal_operation(episode, operation) do
    with :ok <- validate_memory_internal_operation(operation),
         :ok <- prepare_memory_internal_operation(episode, operation) do
      external_operation_id = UUID.generate()

      external = %ExternalOperation{
        external_operation_id: external_operation_id,
        request_key: operation.request_key,
        request_fingerprint: operation.fingerprint,
        name: operation.name,
        payload: operation.payload,
        status: :pending,
        attempt_count: 0,
        actor_kind: Map.get(operation.payload, "actorKind"),
        actor_id: Map.get(operation.payload, "actorId"),
        recording_id: operation.payload["recordingId"],
        deadline_generation: operation.payload["deadlineGeneration"]
      }

      accepted = %{
        episode
        | operations: Map.put(episode.operations, external_operation_id, external)
      }

      next =
        case operation.name do
          :start_recording ->
            {:ok, next_episode} = persist_memory_recording_acceptance(accepted, external)
            next_episode

          :recording_capture_ready ->
            persist_memory_recording_capture_epoch(accepted, external)

          _ ->
            accepted
        end

      {:ok, operation_decision(external, :original), next}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp begin_new_memory_operation(episode, identity, operation) do
    with {:ok, participant} <- active_participant(episode, identity),
         :ok <- capability(episode, identity, participant, operation.name),
         {:ok, target} <- operation_target(episode, identity, operation),
         :ok <- prepare_memory_recording_start(episode, operation) do
      persist_new_memory_operation(episode, identity, operation, target)
    else
      {:error, reason} ->
        rejected_memory_operation(operation, reason)
    end
  end

  defp persist_new_memory_operation(episode, identity, operation, target) do
    external_operation_id = UUID.generate()
    external = memory_external_operation(external_operation_id, identity, operation, target)

    accepted = %{
      episode
      | operations: Map.put(episode.operations, external_operation_id, external)
    }

    case persist_memory_recording_acceptance(accepted, external) do
      {:ok, next} ->
        {:ok, operation_decision(external, :original), next}

      {:error, reason} ->
        rejected_memory_operation(operation, reason)
    end
  end

  defp memory_external_operation(external_operation_id, identity, operation, target) do
    observed = operation.observed_context

    %ExternalOperation{
      external_operation_id: external_operation_id,
      request_key: operation.request_key,
      request_fingerprint: operation.fingerprint,
      name: operation.name,
      payload: operation.payload,
      status: :pending,
      attempt_count: 0,
      actor_kind: "participant",
      actor_id: normalize_id(identity.participant_id),
      actor_participant_id: normalize_id(identity.participant_id),
      actor_generation: identity.participant_generation,
      target_participant_id: target && target.id,
      target_participant_generation: target && target.generation,
      recording_id: operation.payload["recordingId"],
      journey_id: observed && observed.journey_id,
      parent_journey_event_id: observed && observed.parent_journey_event_id,
      producing_trace_id: observed && observed.producing_trace_id,
      producing_span_id: observed && observed.producing_span_id,
      producing_traceparent: observed && observed.producing_traceparent,
      producing_tracestate: observed && observed.producing_tracestate
    }
  end

  defp rejected_memory_operation(operation, reason) do
    {:ok,
     %OperationDecision{
       request_key: operation.request_key,
       result: :rejected,
       reason: normalize_reason(reason)
     }}
  end

  defp validate_memory_internal_operation(%{name: :start_recording, payload: payload}) do
    if system_recording_start?(payload), do: :ok, else: {:error, :invalid_internal_operation}
  end

  defp validate_memory_internal_operation(%{name: :recording_capture_ready}), do: :ok

  defp validate_memory_internal_operation(%{name: :recording_capture_stopped}), do: :ok

  defp validate_memory_internal_operation(%{name: name})
       when name in [
              :admission_request_expired,
              :tenant_set_deadline,
              :tenant_end_episode,
              :maximum_duration_expired
            ],
       do: :ok

  defp validate_memory_internal_operation(_operation), do: {:error, :invalid_internal_operation}

  defp prepare_memory_internal_operation(episode, %{name: :start_recording} = operation),
    do: prepare_memory_recording_start(episode, operation)

  defp prepare_memory_internal_operation(episode, %{name: :recording_capture_ready} = operation) do
    recording = episode.state.recording
    start_operation_id = operation.payload["startOperationId"]
    recording_id = operation.payload["recordingId"]

    with %{"recording_id" => ^recording_id, "status" => "starting"} <- recording,
         %{
           ^start_operation_id => %{
             name: :start_recording,
             status: :applied,
             recording_id: ^recording_id
           }
         } <-
           episode.operations do
      if Map.get(episode.recording_capture_epochs, recording_id, 0) <
           operation.payload["captureEpoch"] do
        :ok
      else
        {:error, :stale_recording_fence}
      end
    else
      _ -> {:error, :stale_recording_fence}
    end
  end

  defp prepare_memory_internal_operation(
         episode,
         %{name: :recording_capture_stopped} = operation
       ) do
    recording = episode.state.recording
    stop_operation_id = operation.payload["stopOperationId"]
    recording_id = operation.payload["recordingId"]
    capture_epoch = operation.payload["captureEpoch"]

    with %{"recording_id" => ^recording_id, "status" => "stopping"} <- recording,
         %{
           ^stop_operation_id => %{
             name: :stop_recording,
             status: :applied,
             recording_id: ^recording_id
           }
         } <- episode.operations,
         ^capture_epoch <- Map.get(episode.recording_capture_epochs, recording_id) do
      :ok
    else
      _ -> {:error, :stale_recording_fence}
    end
  end

  defp prepare_memory_internal_operation(_episode, _operation), do: :ok

  defp prepare_memory_recording_start(_episode, %{name: name})
       when name not in [:start_recording, :stop_recording],
       do: :ok

  defp prepare_memory_recording_start(episode, %{name: :start_recording}) do
    case episode.state.recording do
      nil -> :ok
      %{"status" => status} when status in ["stopped", "failed"] -> :ok
      _ -> {:error, :recording_in_progress}
    end
  end

  defp prepare_memory_recording_start(episode, %{name: :stop_recording} = operation) do
    recording_id = operation.payload["recordingId"]

    case episode.state.recording do
      %{
        "recording_id" => ^recording_id,
        "status" => "recording",
        "failure_code" => nil
      } ->
        :ok

      _ ->
        {:error, :invalid_state}
    end
  end

  defp system_recording_start?(payload) do
    payload["actorKind"] == "system" and payload["actorId"] == "recording_policy" and
      is_binary(payload["recordingId"])
  end

  defp persist_memory_recording_acceptance(
         episode,
         %{name: name} = external
       )
       when name in [:start_recording, :stop_recording] do
    status = if name == :start_recording, do: "starting", else: "stopping"

    payload = %{
      "recording_id" => external.recording_id,
      "status" => status,
      "failure_code" => nil
    }

    case Reducer.apply_external(episode.state, :recording_status_changed, payload) do
      {:ok, event, state} ->
        event_id = UUID.generate()

        stored_event =
          external_memory_event(event, event_id, external.external_operation_id, state)

        {:ok,
         %{
           episode
           | state: state,
             events: :queue.in(stored_event, episode.events)
         }}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp persist_memory_recording_acceptance(episode, _external), do: {:ok, episode}

  defp persist_memory_recording_capture_epoch(episode, external) do
    recording_capture_epochs =
      Map.put(
        episode.recording_capture_epochs,
        external.recording_id,
        external.payload["captureEpoch"]
      )

    %{episode | recording_capture_epochs: recording_capture_epochs}
  end

  defp operation_target(episode, identity, %{name: :participant_leave}) do
    id = normalize_id(identity.participant_id)
    {:ok, Map.put(episode.participants[id], :id, id)}
  end

  defp operation_target(episode, _identity, %{payload: %{"participantId" => raw_id}}) do
    id = normalize_id(raw_id)

    case episode.participants do
      %{^id => %{status: :active} = participant} -> {:ok, Map.put(participant, :id, id)}
      _ -> {:error, :invalid_target}
    end
  end

  defp operation_target(_episode, _identity, _operation), do: {:ok, nil}

  defp finalize_memory_operation(episode, external_operation_id, outcome) do
    case episode.operations do
      %{^external_operation_id => %{status: status} = operation} when status != :pending ->
        {:ok, operation_decision(operation, :duplicate), episode}

      %{^external_operation_id => %{name: name} = operation}
      when name in [:recording_capture_ready, :recording_capture_stopped] ->
        with :ok <- validate_memory_recording_capture_epoch(episode, operation) do
          do_finalize_memory_operation(episode, operation, outcome)
        end

      %{^external_operation_id => operation} ->
        do_finalize_memory_operation(episode, operation, outcome)

      _ ->
        {:error, :operation_not_found}
    end
  end

  defp do_finalize_memory_operation(
         episode,
         %{name: name} = operation,
         {:confirmed, :local}
       )
       when name in [
              :recording_capture_ready,
              :recording_capture_stopped,
              :participant_leave,
              :end_episode,
              :tenant_end_episode,
              :maximum_duration_expired
            ] do
    {event_name, payload} =
      case name do
        :recording_capture_ready ->
          {:recording_status_changed, recording_ready_payload(operation)}

        :recording_capture_stopped ->
          {:recording_status_changed, recording_stopped_payload(operation)}

        _ ->
          local_memory_outcome(operation, episode.state)
      end

    do_finalize_memory_operation(episode, operation, {:applied, event_name, payload})
  end

  defp do_finalize_memory_operation(
         episode,
         %{name: name} = operation,
         {:confirmed, :recording}
       )
       when name in [:start_recording, :stop_recording] do
    applied = %{operation | status: :applied}

    next = %{
      episode
      | operations: Map.put(episode.operations, operation.external_operation_id, applied)
    }

    {:ok, operation_decision(applied, :original, episode.state), next}
  end

  defp do_finalize_memory_operation(
         episode,
         %{name: name} = operation,
         {:failed, reason}
       )
       when name in [
              :start_recording,
              :stop_recording,
              :recording_capture_ready,
              :recording_capture_stopped
            ] and
              is_atom(reason) do
    failure_payload = %{
      "recording_id" => operation.recording_id,
      "status" => "failed",
      "failure_code" => Atom.to_string(reason)
    }

    case Reducer.apply_external(episode.state, :recording_status_changed, failure_payload) do
      {:ok, event, state} ->
        event_id = UUID.generate()

        stored_event =
          external_memory_event(event, event_id, operation.external_operation_id, state)

        failed = %{operation | status: :failed, last_error_code: reason}

        next = %{
          episode
          | state: state,
            events: :queue.in(stored_event, episode.events),
            operations: Map.put(episode.operations, operation.external_operation_id, failed)
        }

        {:ok, operation_decision(failed, :original, state), next}

      {:error, _reason} ->
        failed = %{operation | status: :failed, last_error_code: reason}

        next = %{
          episode
          | operations: Map.put(episode.operations, operation.external_operation_id, failed)
        }

        {:ok, operation_decision(failed, :original), next}
    end
  end

  defp do_finalize_memory_operation(episode, operation, {:failed, reason}) when is_atom(reason) do
    failed = %{operation | status: :failed, last_error_code: reason}

    next = %{
      episode
      | operations: Map.put(episode.operations, operation.external_operation_id, failed)
    }

    {:ok, operation_decision(failed, :original), next}
  end

  defp do_finalize_memory_operation(episode, operation, {:applied, name, payload})
       when is_atom(name) and is_map(payload) do
    with :ok <- valid_operation_fact(operation.name, name),
         {:ok, event, state} <- apply_operation_fact(episode.state, operation, name, payload) do
      event_id = UUID.generate()

      stored_event =
        external_memory_event(event, event_id, operation.external_operation_id, state)

      applied = %{
        operation
        | status: :applied,
          applied_event_id: event_id,
          applied_revision: event.revision
      }

      next = %{
        episode
        | state: state,
          participants: sync_product_roles(episode.participants, state),
          events: :queue.in(stored_event, episode.events),
          operations: Map.put(episode.operations, operation.external_operation_id, applied)
      }

      {:ok, operation_decision(applied, :original, state), next}
    else
      _ -> {:error, :invalid_operation_outcome}
    end
  end

  defp do_finalize_memory_operation(_episode, _operation, _outcome),
    do: {:error, :invalid_operation_outcome}

  defp validate_memory_recording_capture_epoch(episode, operation) do
    if episode.recording_capture_epochs[operation.recording_id] ==
         operation.payload["captureEpoch"] do
      :ok
    else
      {:error, :stale_recording_fence}
    end
  end

  defp local_memory_outcome(%{name: :participant_leave} = operation, state) do
    {:change, event, _next_state} =
      Reducer.decide_external(
        state,
        :participant_leave,
        %{"participant_id" => operation.target_participant_id, "reason" => "left"}
      )

    {String.to_existing_atom(event.name), event.payload}
  end

  defp local_memory_outcome(%{name: :end_episode}, _state),
    do: {:episode_ended, %{"reason" => "ended_by_participant"}}

  defp local_memory_outcome(%{name: :tenant_end_episode}, _state),
    do: {:episode_ended, %{"reason" => "tenant_recovery"}}

  defp local_memory_outcome(%{name: :maximum_duration_expired}, _state),
    do: {:episode_ended, %{"reason" => "maximum_duration"}}

  defp recording_ready_payload(operation) do
    %{
      "recording_id" => operation.recording_id,
      "status" => "recording",
      "failure_code" => nil
    }
  end

  defp recording_stopped_payload(operation) do
    %{
      "recording_id" => operation.recording_id,
      "status" => "stopped",
      "failure_code" => nil
    }
  end

  defp apply_operation_fact(state, operation, :participant_left, payload),
    do: external_leave(state, operation, payload)

  defp apply_operation_fact(state, _operation, name, payload),
    do: Reducer.apply_external(state, name, payload)

  defp external_leave(state, operation, _payload) do
    case Reducer.decide_external(
           state,
           :participant_leave,
           %{"participant_id" => operation.target_participant_id}
         ) do
      {:change, event, next} -> {:ok, event, next}
      other -> other
    end
  end

  defp valid_operation_fact(:deny_admission, :admission_denied), do: :ok
  defp valid_operation_fact(:admission_request_expired, :admission_expired), do: :ok
  defp valid_operation_fact(:mute_participant, :participant_microphone_stopped), do: :ok
  defp valid_operation_fact(:stop_participant_camera, :participant_camera_stopped), do: :ok

  defp valid_operation_fact(:stop_participant_screen_share, :participant_screen_share_stopped),
    do: :ok

  defp valid_operation_fact(:remove_participant, :participant_left),
    do: :ok

  defp valid_operation_fact(:participant_leave, :participant_left),
    do: :ok

  defp valid_operation_fact(:end_episode, :episode_ended), do: :ok

  defp valid_operation_fact(name, :episode_ended)
       when name in [:tenant_end_episode, :maximum_duration_expired],
       do: :ok

  defp valid_operation_fact(name, :recording_status_changed)
       when name in [
              :start_recording,
              :stop_recording,
              :recording_capture_ready,
              :recording_capture_stopped
            ],
       do: :ok

  defp valid_operation_fact(_operation, _event), do: {:error, :invalid_operation_outcome}

  defp operation_decision(operation, delivery, state \\ nil) do
    result = if operation.status == :pending, do: :pending, else: operation.status

    %OperationDecision{
      request_key: operation.request_key,
      result: result,
      delivery: delivery,
      external_operation_id: operation.external_operation_id,
      event_id: operation.applied_event_id,
      revision: operation.applied_revision,
      state_digest: state && Reducer.digest(state),
      reason: operation.last_error_code
    }
  end

  defp external_memory_event(event, event_id, external_operation_id, state) do
    event
    |> Map.put(:event_id, event_id)
    |> Map.put(:command_id, nil)
    |> Map.put(:lifecycle_intent_id, nil)
    |> Map.put(:external_operation_id, external_operation_id)
    |> Map.put(:schema_version, 1)
    |> Map.put(:resulting_state_digest, Reducer.digest(state))
  end

  defp persist_commit(episode, identity, command, event, state) do
    event_id = UUID.generate()
    stored_event = memory_event(event, event_id, command.id, state)

    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :committed,
      event_id: event_id,
      revision: event.revision,
      state_digest: Reducer.digest(state),
      reason: nil
    }

    episode = %{
      episode
      | state: state,
        participants: sync_product_roles(episode.participants, state),
        events: :queue.in(stored_event, episode.events),
        receipts: Map.put(episode.receipts, receipt_key(identity, command), receipt)
    }

    decision = %Decision{
      command_id: command.id,
      result: :committed,
      delivery: :original,
      event_id: event_id,
      revision: event.revision,
      state_digest: Reducer.digest(state),
      event: stored_event
    }

    {:ok, decision, episode}
  end

  defp persist_satisfied(episode, identity, command, state) do
    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :satisfied,
      event_id: nil,
      revision: state.revision,
      state_digest: Reducer.digest(state),
      reason: nil
    }

    episode = %{
      episode
      | receipts: Map.put(episode.receipts, receipt_key(identity, command), receipt)
    }

    decision = %Decision{
      command_id: command.id,
      result: :satisfied,
      delivery: :original,
      revision: state.revision,
      state_digest: receipt.state_digest
    }

    {:ok, decision, episode}
  end

  defp persist_rejection(episode, identity, command, reason) do
    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :rejected,
      event_id: nil,
      revision: nil,
      reason: reason
    }

    episode = %{
      episode
      | receipts: Map.put(episode.receipts, receipt_key(identity, command), receipt)
    }

    {:ok, %Decision{command_id: command.id, result: :rejected, reason: reason}, episode}
  end

  defp receipt_decision(episode, identity, command) do
    key = receipt_key(identity, command)

    case episode.receipts do
      %{^key => receipt} ->
        {:ok, decision_from_receipt(command, receipt)}

      _ ->
        :not_found
    end
  end

  defp decision_from_receipt(command, %{fingerprint: fingerprint})
       when fingerprint != command.fingerprint do
    %Decision{
      command_id: command.id,
      result: :command_id_conflict,
      reason: :command_id_conflict
    }
  end

  defp decision_from_receipt(command, %{outcome: :committed} = receipt) do
    %Decision{
      command_id: command.id,
      result: duplicate_result(command, :committed),
      delivery: :duplicate,
      event_id: receipt.event_id,
      revision: receipt.revision,
      state_digest: receipt.state_digest
    }
  end

  defp decision_from_receipt(command, %{outcome: :satisfied} = receipt) do
    %Decision{
      command_id: command.id,
      result: :satisfied,
      delivery: :duplicate,
      revision: receipt.revision,
      state_digest: receipt.state_digest
    }
  end

  defp decision_from_receipt(command, %{outcome: :rejected} = receipt) do
    %Decision{command_id: command.id, result: :rejected, reason: receipt.reason}
  end

  defp active_participant(episode, identity) do
    participant_id = normalize_id(identity.participant_id)
    submitted_generation = identity.participant_generation

    case episode.participants do
      %{
        ^participant_id => %{status: :active, generation: ^submitted_generation} = participant
      } ->
        validate_memory_admission(participant, identity)

      %{^participant_id => %{generation: _generation}} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp memory_participant_authority(episode, participant_id, expected_generation) do
    case episode.participants do
      %{^participant_id => %{status: :active, generation: generation}}
      when is_nil(expected_generation) or generation == expected_generation ->
        case episode.state.participants do
          %{^participant_id => folded} ->
            {:ok,
             %{
               participant_id: participant_id,
               generation: generation,
               role: folded.role,
               capabilities: Map.fetch!(episode.state.role_capabilities, folded.role)
             }}

          _ ->
            {:error, :participant_inactive}
        end

      %{^participant_id => %{generation: generation}}
      when is_integer(expected_generation) and generation != expected_generation ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp validate_memory_admission(participant, %{admission_lifecycle_intent_id: nil}),
    do: {:ok, participant}

  defp validate_memory_admission(
         %{admission_lifecycle_intent_id: admission_id} = participant,
         %{admission_lifecycle_intent_id: claimed_admission_id}
       )
       when is_binary(admission_id),
       do:
         if(normalize_id(claimed_admission_id) == admission_id,
           do: {:ok, participant},
           else: {:error, :participant_inactive}
         )

  defp validate_memory_admission(_participant, _identity),
    do: {:error, :participant_inactive}

  defp capability(episode, identity, _participant, name) do
    participant_id = normalize_id(identity.participant_id)
    folded_participant = episode.state.participants[participant_id]
    required = required_capability(name)
    capabilities = Map.fetch!(episode.state.role_capabilities, folded_participant.role)

    cond do
      name == :participant_leave ->
        :ok

      required in capabilities ->
        :ok

      true ->
        {:error, :capability_denied}
    end
  end

  defp required_capability(:set_hand_raised),
    do: "raiseHand"

  defp required_capability(:set_display_name), do: "renameSelf"
  defp required_capability(:set_admission_policy), do: "manageAdmission"
  defp required_capability(:assign_roles), do: "assignRoles"

  defp required_capability(name) when name in [:admit_participant, :deny_admission],
    do: "manageAdmission"

  defp required_capability(:mute_participant), do: "muteOthers"
  defp required_capability(:stop_participant_camera), do: "stopVideoOthers"
  defp required_capability(:stop_participant_screen_share), do: "stopScreenOthers"
  defp required_capability(:remove_participant), do: "removeParticipant"

  defp required_capability(name) when name in [:start_recording, :stop_recording],
    do: "manageRecording"

  defp required_capability(:participant_leave), do: "self"
  defp required_capability(:start_episode), do: "startEpisode"
  defp required_capability(:extend_episode), do: "extendEpisode"
  defp required_capability(:end_episode), do: "endEpisode"

  defp recovery_for_cursor(episode, cursor, head, protocol_version) do
    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: :up_to_date, head: head, snapshot: nil, events: []}

      cursor.revision < head.revision and historical_cursor_matches?(episode, cursor) ->
        replay_recovery(episode, cursor.revision, head, protocol_version)

      true ->
        snapshot_recovery(episode, protocol_version)
    end
  end

  defp cursor_matches_head?(cursor, head) do
    cursor.revision == head.revision and
      cursor.state_schema_version == head.state_schema_version and
      cursor.digest == head.digest
  end

  defp historical_cursor_matches?(episode, cursor) do
    cursor.state_schema_version == Reducer.state_schema_version() and
      historical_digest(episode, cursor.revision) == cursor.digest
  end

  defp historical_digest(episode, 0),
    do: episode.episode.episode_id |> Reducer.new() |> Reducer.digest()

  defp historical_digest(episode, revision) do
    episode.events
    |> :queue.to_list()
    |> Enum.find_value(fn event ->
      if event.revision == revision, do: event.resulting_state_digest
    end)
  end

  defp replay_recovery(episode, revision, head, protocol_version) do
    retained = :queue.to_list(episode.events)
    events = Enum.filter(retained, &(&1.revision > revision))
    oldest_revision = if match?([_ | _], retained), do: hd(retained).base_revision, else: 0

    if revision >= oldest_revision and length(events) <= 2_048 and
         Enum.sum(Enum.map(events, &(ProtocolV1.event(&1) |> byte_size()))) <= 2 * 1024 * 1024 do
      %Recovery{
        mode: :replay,
        head: head,
        snapshot: nil,
        events: [],
        replay_cursor: revision
      }
    else
      snapshot_recovery(episode, protocol_version)
    end
  end

  defp bounded_recovery_page(events) do
    events
    |> Enum.reduce_while({[], 0}, fn event, {accepted, bytes} ->
      event_bytes = event |> ProtocolV1.event() |> byte_size()

      if length(accepted) < 128 and bytes + event_bytes <= 255 * 1024,
        do: {:cont, {[event | accepted], bytes + event_bytes}},
        else: {:halt, {accepted, bytes}}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp recover_identity(episode, identity, cursor) do
    case active_participant(episode, identity) do
      {:ok, _participant} -> {:ok, recovery(episode, cursor, identity.protocol_version)}
      {:error, reason} -> {:ok, terminal_recovery(episode, reason)}
    end
  end

  defp recovery(episode, cursor), do: recovery(episode, cursor, 1)

  defp recovery(episode, nil, protocol_version),
    do: snapshot_recovery(episode, protocol_version)

  defp recovery(
         episode,
         %{revision: revision, state_schema_version: schema, digest: digest},
         protocol_version
       )
       when is_integer(revision) and revision >= 0 and is_integer(schema) and is_binary(digest) do
    head = recovery_head(episode.state)

    recovery_for_cursor(
      episode,
      %{revision: revision, state_schema_version: schema, digest: digest},
      head,
      protocol_version
    )
  end

  defp recovery(episode, _cursor, protocol_version),
    do: snapshot_recovery(episode, protocol_version)

  defp snapshot_recovery(episode, protocol_version) do
    mode = if episode.state.status == "ended", do: :terminal, else: :snapshot

    %Recovery{
      mode: mode,
      head: recovery_head(episode.state),
      snapshot:
        if(mode == :terminal, do: nil, else: Reducer.snapshot(episode.state, protocol_version)),
      events: [],
      terminal_reason: if(mode == :terminal, do: :episode_ended)
    }
  end

  defp terminal_recovery(episode, reason) do
    %Recovery{
      mode: :terminal,
      head: recovery_head(episode.state),
      snapshot: nil,
      events: [],
      terminal_reason: reason
    }
  end

  defp recovery_head(state) do
    %{
      revision: state.revision,
      state_schema_version: Reducer.state_schema_version(),
      digest: Reducer.digest(state)
    }
  end

  defp memory_event(event, event_id, command_id, state) do
    event
    |> Map.put(:event_id, event_id || UUID.generate())
    |> Map.put(:command_id, command_id)
    |> Map.put(:lifecycle_intent_id, if(command_id, do: nil, else: UUID.generate()))
    |> Map.put(:schema_version, 1)
    |> Map.put(:resulting_state_digest, Reducer.digest(state))
  end

  defp receipt_key(identity, command),
    do: {normalize_id(identity.participant_id), command.id}

  defp normalize_reason(:not_joined), do: :participant_inactive
  defp normalize_reason(:episode_ended), do: :episode_ended
  defp normalize_reason(:invalid_target), do: :invalid_target
  defp normalize_reason(_reason), do: :invalid_state

  defp sync_product_roles(participants, state) do
    Map.new(participants, fn {id, participant} ->
      folded = state.participants[id]
      {id, if(folded, do: %{participant | role: folded.role}, else: participant)}
    end)
  end

  defp duplicate_result(_command, outcome), do: outcome

  defp normalize_id(nil), do: nil
  defp normalize_id(value) when is_binary(value), do: String.downcase(value)
end
