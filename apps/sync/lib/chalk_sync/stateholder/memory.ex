defmodule ChalkSync.Stateholder.Memory do
  @moduledoc """
  ETS-backed stateholder adapter for single-node dev and test.

  All writes serialize through this GenServer so compare-and-set commits are
  atomic even if a second (buggy) writer appears. Reads go straight to ETS.
  """

  @behaviour ChalkSync.Stateholder

  use GenServer

  @rooms __MODULE__.Rooms
  @events __MODULE__.Events
  @sessions __MODULE__.Sessions
  @retained_events 500

  alias ChalkSync.ProtocolV3
  alias ChalkSync.Sessions.Reducer
  alias ChalkSync.Stateholder.Command
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.LifecycleDecision
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Recovery
  alias ChalkSync.Stateholder.SessionKey
  alias ChalkSync.UUID

  def start_link(opts) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl ChalkSync.Stateholder
  def load(room_id) do
    case :ets.lookup(@rooms, room_id) do
      [{^room_id, state}] -> {:ok, state}
      [] -> :not_found
    end
  end

  @impl ChalkSync.Stateholder
  def commit(room_id, expected_revision, event, state) do
    GenServer.call(__MODULE__, {:commit, room_id, expected_revision, event, state})
  end

  @impl ChalkSync.Stateholder
  def events_since(room_id, cursor) do
    case :ets.lookup(@events, room_id) do
      [] when cursor == 0 ->
        {:ok, []}

      [] ->
        {:error, :cursor_unavailable}

      [{^room_id, newest_first}] ->
        oldest_retained = List.last(newest_first).base_revision

        if cursor < oldest_retained do
          {:error, :cursor_unavailable}
        else
          {:ok, newest_first |> Enum.take_while(&(&1.revision > cursor)) |> Enum.reverse()}
        end
    end
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
  def recover(%SessionKey{} = session, cursor),
    do: GenServer.call(__MODULE__, {:recover_session, session, cursor})

  @impl ChalkSync.Stateholder
  def recover_session(%SessionKey{} = session, cursor), do: recover(session, cursor)

  @impl ChalkSync.Stateholder
  def recovery_page(%SessionKey{} = session, after_revision, through_revision) do
    GenServer.call(
      __MODULE__,
      {:recovery_page, session, after_revision, through_revision}
    )
  end

  @impl ChalkSync.Stateholder
  def apply_lifecycle_intent(%SessionKey{} = session, lifecycle_intent_id),
    do: GenServer.call(__MODULE__, {:apply_lifecycle_intent, session, lifecycle_intent_id})

  @impl ChalkSync.Stateholder
  def record_lifecycle_failure(_session, _lifecycle_intent_id, _reason), do: :ok

  @impl ChalkSync.Stateholder
  def pending_lifecycle_intents(_limit), do: {:ok, []}

  @impl ChalkSync.Stateholder
  def begin_operation(%Identity{} = identity, %Operation{} = operation),
    do: GenServer.call(__MODULE__, {:begin_operation, identity, operation})

  @impl ChalkSync.Stateholder
  def begin_internal_operation(%SessionKey{} = session, %Operation{} = operation),
    do: GenServer.call(__MODULE__, {:begin_internal_operation, session, operation})

  @impl ChalkSync.Stateholder
  def claim_operations(limit), do: GenServer.call(__MODULE__, {:claim_operations, limit})

  @impl ChalkSync.Stateholder
  def claim_local_operations(limit),
    do: GenServer.call(__MODULE__, {:claim_local_operations, limit})

  @impl ChalkSync.Stateholder
  def read_operation(%SessionKey{} = session, external_operation_id),
    do: GenServer.call(__MODULE__, {:read_operation, session, external_operation_id})

  @impl ChalkSync.Stateholder
  def finalize_operation(%SessionKey{} = session, external_operation_id, outcome),
    do: GenServer.call(__MODULE__, {:finalize_operation, session, external_operation_id, outcome})

  @impl ChalkSync.Stateholder
  def participant_authority(%SessionKey{} = session, participant_session_id, expected_generation),
    do:
      GenServer.call(
        __MODULE__,
        {:participant_authority, session, participant_session_id, expected_generation}
      )

  @impl ChalkSync.Stateholder
  def reserve_publication_grant(_identity, _operation_id, _source),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def complete_publication_grant(_session, _reservation_id, _outcome),
    do: {:retryable, :dependency_unavailable}

  @impl ChalkSync.Stateholder
  def begin_role_transition(identity, command, _publications),
    do: decide_command(identity, command)

  @doc "Seeds one deterministic Session for adapter conformance tests."
  def seed_session(%SessionKey{} = session, participants \\ []) when is_list(participants) do
    GenServer.call(__MODULE__, {:seed_session, session, participants})
  end

  @doc false
  def seed_admission_request(%SessionKey{} = session, payload),
    do: GenServer.call(__MODULE__, {:seed_admission_request, session, payload})

  @doc "Test helper: drops all rooms and events."
  def reset do
    GenServer.call(__MODULE__, :reset)
  end

  @impl GenServer
  def init(_opts) do
    :ets.new(@rooms, [:named_table, :protected, read_concurrency: true])
    :ets.new(@events, [:named_table, :protected, read_concurrency: true])
    :ets.new(@sessions, [:named_table, :protected, read_concurrency: true])
    {:ok, %{}}
  end

  @impl GenServer
  def handle_call({:commit, room_id, expected_revision, event, state}, _from, s) do
    current_revision =
      case :ets.lookup(@rooms, room_id) do
        [{^room_id, current}] -> current.revision
        [] -> 0
      end

    if current_revision == expected_revision do
      :ets.insert(@rooms, {room_id, state})
      append_event(room_id, event)
      {:reply, :ok, s}
    else
      {:reply, {:error, {:revision_conflict, current_revision}}, s}
    end
  end

  def handle_call(:reset, _from, s) do
    :ets.delete_all_objects(@rooms)
    :ets.delete_all_objects(@events)
    :ets.delete_all_objects(@sessions)
    {:reply, :ok, s}
  end

  def handle_call({:seed_session, session, participants}, _from, server_state) do
    authority_key = SessionKey.authority_key(session)

    if :ets.member(@sessions, authority_key) do
      {:reply, {:error, :already_exists}, server_state}
    else
      case seeded_session(session, participants) do
        {:ok, state} ->
          :ets.insert(@sessions, {authority_key, state})
          {:reply, :ok, server_state}

        {:error, reason} ->
          {:reply, {:error, reason}, server_state}
      end
    end
  end

  def handle_call({:seed_admission_request, session_key, payload}, _from, server_state) do
    key = SessionKey.authority_key(session_key)

    case :ets.lookup(@sessions, key) do
      [{^key, session}] ->
        case Reducer.apply_lifecycle(session.state, :admission_requested, payload) do
          {:ok, event, state} ->
            next = %{
              session
              | state: state,
                events: :queue.in(memory_event(event, nil, nil, state), session.events)
            }

            :ets.insert(@sessions, {key, next})
            {:reply, :ok, server_state}

          error ->
            {:reply, error, server_state}
        end

      [] ->
        {:reply, {:error, :session_not_found}, server_state}
    end
  end

  def handle_call(
        {:participant_authority, session_key, participant_session_id, expected_generation},
        _from,
        server_state
      ) do
    key = SessionKey.authority_key(session_key)
    participant_session_id = normalize_id(participant_session_id)

    reply =
      case :ets.lookup(@sessions, key) do
        [{^key, %{state: %{status: "active"}} = session}] ->
          memory_participant_authority(session, participant_session_id, expected_generation)

        [{^key, _session}] ->
          {:error, :session_ended}

        [] ->
          {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:decide_command, identity, command}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> decide(session, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    case reply do
      {:ok, decision, session} ->
        :ets.insert(@sessions, {authority_key, session})
        {:reply, {:ok, decision}, server_state}

      other ->
        {:reply, other, server_state}
    end
  end

  def handle_call({:begin_operation, identity, operation}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    case :ets.lookup(@sessions, authority_key) do
      [{^authority_key, session}] ->
        case begin_memory_operation(session, identity, operation) do
          {:ok, decision, next} ->
            :ets.insert(@sessions, {authority_key, next})
            {:reply, {:ok, decision}, server_state}

          {:ok, decision} ->
            {:reply, {:ok, decision}, server_state}
        end

      [] ->
        {:reply, {:retryable, :dependency_unavailable}, server_state}
    end
  end

  def handle_call({:begin_internal_operation, session_key, operation}, _from, server_state) do
    authority_key = SessionKey.authority_key(session_key)

    case :ets.lookup(@sessions, authority_key) do
      [{^authority_key, session}] ->
        case begin_memory_internal_operation(session, operation) do
          {:ok, decision, next} ->
            :ets.insert(@sessions, {authority_key, next})
            {:reply, {:ok, decision}, server_state}

          other ->
            {:reply, other, server_state}
        end

      [] ->
        {:reply, {:error, :session_not_found}, server_state}
    end
  end

  def handle_call({:claim_operations, limit}, _from, server_state),
    do: claim_memory_operations(server_state, limit, fn _operation -> true end)

  def handle_call({:claim_local_operations, limit}, _from, server_state) do
    claim_memory_operations(server_state, limit, fn operation ->
      operation.name in [
        :participant_leave,
        :end_session,
        :tenant_end_session,
        :maximum_duration_expired
      ]
    end)
  end

  def handle_call({:read_operation, session_key, external_operation_id}, _from, server_state) do
    key = SessionKey.authority_key(session_key)

    reply =
      with [{^key, session}] <- :ets.lookup(@sessions, key),
           %{^external_operation_id => operation} <- session.operations do
        {:ok, operation}
      else
        _ -> :not_found
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:finalize_operation, session_key, external_operation_id, outcome},
        _from,
        server_state
      ) do
    key = SessionKey.authority_key(session_key)

    case :ets.lookup(@sessions, key) do
      [{^key, session}] ->
        case finalize_memory_operation(session, external_operation_id, outcome) do
          {:ok, decision, next} ->
            :ets.insert(@sessions, {key, next})
            {:reply, {:ok, decision}, server_state}

          error ->
            {:reply, error, server_state}
        end

      [] ->
        {:reply, {:error, :session_not_found}, server_state}
    end
  end

  def handle_call({:resolve_receipt, identity, command}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> receipt_decision(session, identity, command)
        [] -> {:retryable, :dependency_unavailable}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover, identity, cursor}, _from, server_state) do
    authority_key = SessionKey.authority_key(identity.session)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> recover_identity(session, identity, cursor)
        [] -> {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call({:recover_session, session_key, cursor}, _from, server_state) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] -> {:ok, recovery(session, cursor)}
        [] -> {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:recovery_page, session_key, after_revision, through_revision},
        _from,
        server_state
      ) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] ->
          events =
            session.events
            |> :queue.to_list()
            |> Enum.filter(&(&1.revision > after_revision and &1.revision <= through_revision))
            |> bounded_recovery_page()

          {:ok, events}

        [] ->
          {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  def handle_call(
        {:apply_lifecycle_intent, session_key, lifecycle_intent_id},
        _from,
        server_state
      ) do
    authority_key = SessionKey.authority_key(session_key)

    reply =
      case :ets.lookup(@sessions, authority_key) do
        [{^authority_key, session}] ->
          lifecycle_decision(session, lifecycle_intent_id)

        [] ->
          {:error, :session_not_found}
      end

    {:reply, reply, server_state}
  end

  defp claim_memory_operations(server_state, limit, operation_filter) do
    operations =
      @sessions
      |> :ets.tab2list()
      |> Enum.flat_map(fn {_key, session} ->
        session.operations
        |> Map.values()
        |> Enum.filter(&(&1.status == :pending and operation_filter.(&1)))
        |> Enum.map(&{session.session, &1})
      end)
      |> Enum.sort_by(fn {_session, operation} -> operation.external_operation_id end)
      |> Enum.take(limit)

    {:reply, {:ok, operations}, server_state}
  end

  defp lifecycle_decision(session, lifecycle_intent_id) do
    lifecycle_intent_id = normalize_id(lifecycle_intent_id)

    if lifecycle_intent_applied?(session, lifecycle_intent_id) do
      {:ok,
       %LifecycleDecision{
         lifecycle_intent_id: lifecycle_intent_id,
         result: :already_applied
       }}
    else
      {:error, :lifecycle_intent_not_found}
    end
  end

  defp lifecycle_intent_applied?(session, lifecycle_intent_id) do
    Enum.any?(session.participants, fn {_id, participant} ->
      participant.admission_lifecycle_intent_id == lifecycle_intent_id and
        participant.status == :active
    end)
  end

  defp append_event(room_id, event) do
    newest_first =
      case :ets.lookup(@events, room_id) do
        [{^room_id, events}] -> events
        [] -> []
      end

    :ets.insert(@events, {room_id, Enum.take([event | newest_first], @retained_events)})
  end

  defp seeded_session(session_key, participants) do
    initial = %{
      session: session_key,
      state: Reducer.new(session_key.session_id),
      participants: %{},
      receipts: %{},
      operations: %{},
      events: :queue.new()
    }

    Enum.reduce_while(participants, {:ok, initial}, fn participant, {:ok, session} ->
      case seed_participant(session, participant) do
        {:ok, next} -> {:cont, {:ok, next}}
        {:error, reason} -> {:halt, {:error, reason}}
      end
    end)
  end

  defp seed_participant(session, participant) do
    with %{id: raw_id, generation: generation, display_name: display_name} <- participant,
         id = normalize_id(raw_id),
         true <- is_binary(id) and is_integer(generation) and generation > 0,
         role =
           Map.get(
             participant,
             :role,
             if(map_size(session.participants) == 0, do: "host", else: "participant")
           ),
         eligible_roles =
           Map.get(
             participant,
             :eligible_roles,
             if(role == "host", do: ["host", "cohost", "participant"], else: [role])
           ),
         {:ok, event, state} <-
           Reducer.apply_lifecycle(session.state, :participant_joined, %{
             "participant_session_id" => id,
             "display_name" => display_name,
             "role" => role,
             "eligible_roles" => eligible_roles,
             "admission_revision" => session.state.revision + 1
           }) do
      product = %{
        generation: generation,
        status: :active,
        role: role,
        eligible_roles: eligible_roles,
        admission_lifecycle_intent_id:
          participant |> Map.get(:admission_lifecycle_intent_id) |> normalize_id()
      }

      next = %{
        session
        | state: state,
          participants: Map.put(session.participants, id, product),
          events: :queue.in(memory_event(event, nil, nil, state), session.events)
      }

      {:ok, next}
    else
      _ -> {:error, :invalid_participant}
    end
  end

  defp decide(session, identity, command) do
    case receipt_decision(session, identity, command) do
      {:ok, decision} -> {:ok, decision, session}
      :not_found -> decide_new(session, identity, command)
    end
  end

  defp decide_new(session, identity, command) do
    with {:ok, participant} <- active_participant(session, identity),
         :ok <- capability(session, identity, participant, command.name) do
      persist_reducer_decision(session, identity, command)
    else
      {:error, reason} -> persist_rejection(session, identity, command, reason)
    end
  end

  defp persist_reducer_decision(session, identity, command) do
    case Reducer.decide_command(
           session.state,
           normalize_id(identity.participant_session_id),
           command.name,
           command.payload
         ) do
      {:change, event, state} -> persist_commit(session, identity, command, event, state)
      {:satisfied, state} -> persist_satisfied(session, identity, command, state)
      {:error, reason} -> persist_rejection(session, identity, command, normalize_reason(reason))
    end
  end

  defp begin_memory_operation(session, identity, operation) do
    existing =
      Enum.find(Map.values(session.operations), fn candidate ->
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
        begin_new_memory_operation(session, identity, operation)
    end
  end

  defp begin_memory_internal_operation(session, operation) do
    existing =
      Enum.find(Map.values(session.operations), fn candidate ->
        candidate.name == operation.name and candidate.request_key == operation.request_key
      end)

    cond do
      existing && existing.request_fingerprint != operation.fingerprint ->
        {:ok,
         %OperationDecision{
           request_key: operation.request_key,
           result: :command_id_conflict,
           reason: :command_id_conflict
         }, session}

      existing ->
        {:ok, operation_decision(existing, :duplicate), session}

      operation.name in [
        :admission_request_expired,
        :tenant_transfer_host,
        :tenant_set_deadline,
        :tenant_end_session,
        :maximum_duration_expired
      ] ->
        external_operation_id = UUID.generate()

        external = %ExternalOperation{
          external_operation_id: external_operation_id,
          request_key: operation.request_key,
          request_fingerprint: operation.fingerprint,
          name: operation.name,
          payload: operation.payload,
          status: :pending,
          attempt_count: 0,
          deadline_generation: operation.payload["deadlineGeneration"]
        }

        next = %{
          session
          | operations: Map.put(session.operations, external_operation_id, external)
        }

        {:ok, operation_decision(external, :original), next}

      true ->
        {:error, :invalid_internal_operation}
    end
  end

  defp begin_new_memory_operation(session, identity, operation) do
    with {:ok, participant} <- active_participant(session, identity),
         :ok <- capability(session, identity, participant, operation.name),
         {:ok, target} <- operation_target(session, identity, operation) do
      external_operation_id = UUID.generate()
      observed = operation.observed_context

      external = %ExternalOperation{
        external_operation_id: external_operation_id,
        request_key: operation.request_key,
        request_fingerprint: operation.fingerprint,
        name: operation.name,
        payload: operation.payload,
        status: :pending,
        attempt_count: 0,
        actor_participant_session_id: normalize_id(identity.participant_session_id),
        actor_generation: identity.participant_session_generation,
        target_participant_session_id: target && target.id,
        target_participant_generation: target && target.generation,
        recording_id: operation.payload["recordingId"],
        journey_id: observed && observed.journey_id,
        parent_journey_event_id: observed && observed.parent_journey_event_id,
        producing_trace_id: observed && observed.producing_trace_id,
        producing_span_id: observed && observed.producing_span_id
      }

      next = %{session | operations: Map.put(session.operations, external_operation_id, external)}
      {:ok, operation_decision(external, :original), next}
    else
      {:error, reason} ->
        {:ok,
         %OperationDecision{
           request_key: operation.request_key,
           result: :rejected,
           reason: normalize_reason(reason)
         }}
    end
  end

  defp operation_target(session, identity, %{name: :participant_leave}) do
    id = normalize_id(identity.participant_session_id)
    {:ok, Map.put(session.participants[id], :id, id)}
  end

  defp operation_target(session, _identity, %{payload: %{"participantSessionId" => raw_id}}) do
    id = normalize_id(raw_id)

    case session.participants do
      %{^id => %{status: :active} = participant} -> {:ok, Map.put(participant, :id, id)}
      _ -> {:error, :invalid_target}
    end
  end

  defp operation_target(_session, _identity, _operation), do: {:ok, nil}

  defp finalize_memory_operation(session, external_operation_id, outcome) do
    case session.operations do
      %{^external_operation_id => %{status: status} = operation} when status != :pending ->
        {:ok, operation_decision(operation, :duplicate), session}

      %{^external_operation_id => operation} ->
        do_finalize_memory_operation(session, operation, outcome)

      _ ->
        {:error, :operation_not_found}
    end
  end

  defp do_finalize_memory_operation(
         session,
         %{name: name} = operation,
         {:confirmed, :local}
       )
       when name in [
              :participant_leave,
              :end_session,
              :tenant_end_session,
              :maximum_duration_expired
            ] do
    {event_name, payload} = local_memory_outcome(operation, session.state)
    do_finalize_memory_operation(session, operation, {:applied, event_name, payload})
  end

  defp do_finalize_memory_operation(session, operation, {:failed, reason}) when is_atom(reason) do
    failed = %{operation | status: :failed, last_error_code: reason}

    next = %{
      session
      | operations: Map.put(session.operations, operation.external_operation_id, failed)
    }

    {:ok, operation_decision(failed, :original), next}
  end

  defp do_finalize_memory_operation(session, operation, {:applied, name, payload})
       when is_atom(name) and is_map(payload) do
    with :ok <- valid_operation_fact(operation.name, name),
         {:ok, event, state} <- apply_operation_fact(session.state, operation, name, payload) do
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
        session
        | state: state,
          participants: sync_product_roles(session.participants, state),
          events: :queue.in(stored_event, session.events),
          operations: Map.put(session.operations, operation.external_operation_id, applied)
      }

      {:ok, operation_decision(applied, :original, state), next}
    else
      _ -> {:error, :invalid_operation_outcome}
    end
  end

  defp do_finalize_memory_operation(_session, _operation, _outcome),
    do: {:error, :invalid_operation_outcome}

  defp local_memory_outcome(%{name: :participant_leave} = operation, state) do
    {:change, event, _next_state} =
      Reducer.decide_external(
        state,
        :participant_leave,
        %{"participant_session_id" => operation.target_participant_session_id, "reason" => "left"}
      )

    {String.to_existing_atom(event.name), event.payload}
  end

  defp local_memory_outcome(%{name: :end_session}, _state),
    do: {:session_ended, %{"reason" => "ended_by_participant"}}

  defp local_memory_outcome(%{name: :tenant_end_session}, _state),
    do: {:session_ended, %{"reason" => "tenant_recovery"}}

  defp local_memory_outcome(%{name: :maximum_duration_expired}, _state),
    do: {:session_ended, %{"reason" => "maximum_duration"}}

  defp apply_operation_fact(state, operation, :participant_left, payload),
    do: external_leave(state, operation, payload)

  defp apply_operation_fact(state, operation, :host_left_and_transferred, payload),
    do: external_leave(state, operation, payload)

  defp apply_operation_fact(state, _operation, name, payload),
    do: Reducer.apply_external(state, name, payload)

  defp external_leave(state, operation, _payload) do
    case Reducer.decide_external(
           state,
           :participant_leave,
           %{"participant_session_id" => operation.target_participant_session_id}
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

  defp valid_operation_fact(:remove_participant, name)
       when name in [:participant_left, :host_left_and_transferred],
       do: :ok

  defp valid_operation_fact(:participant_leave, name)
       when name in [:participant_left, :host_left_and_transferred],
       do: :ok

  defp valid_operation_fact(:end_session, :session_ended), do: :ok

  defp valid_operation_fact(name, :session_ended)
       when name in [:tenant_end_session, :maximum_duration_expired],
       do: :ok

  defp valid_operation_fact(name, :recording_status_changed)
       when name in [:start_recording, :stop_recording],
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

  defp persist_commit(session, identity, command, event, state) do
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

    session = %{
      session
      | state: state,
        participants: sync_product_roles(session.participants, state),
        events: :queue.in(stored_event, session.events),
        receipts: Map.put(session.receipts, receipt_key(identity, command), receipt)
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

    {:ok, decision, session}
  end

  defp persist_satisfied(session, identity, command, state) do
    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :satisfied,
      event_id: nil,
      revision: state.revision,
      state_digest: Reducer.digest(state),
      reason: nil
    }

    session = %{
      session
      | receipts: Map.put(session.receipts, receipt_key(identity, command), receipt)
    }

    decision = %Decision{
      command_id: command.id,
      result: :satisfied,
      delivery: :original,
      revision: state.revision,
      state_digest: receipt.state_digest
    }

    {:ok, decision, session}
  end

  defp persist_rejection(session, identity, command, reason) do
    receipt = %{
      fingerprint: command.fingerprint,
      outcome: :rejected,
      event_id: nil,
      revision: nil,
      reason: reason
    }

    session = %{
      session
      | receipts: Map.put(session.receipts, receipt_key(identity, command), receipt)
    }

    {:ok, %Decision{command_id: command.id, result: :rejected, reason: reason}, session}
  end

  defp receipt_decision(session, identity, command) do
    key = receipt_key(identity, command)

    case session.receipts do
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

  defp active_participant(session, identity) do
    participant_session_id = normalize_id(identity.participant_session_id)
    submitted_generation = identity.participant_session_generation

    case session.participants do
      %{
        ^participant_session_id =>
          %{status: :active, generation: ^submitted_generation} = participant
      } ->
        validate_memory_admission(participant, identity)

      %{^participant_session_id => %{generation: _generation}} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp memory_participant_authority(session, participant_session_id, expected_generation) do
    case session.participants do
      %{^participant_session_id => %{status: :active, generation: generation}}
      when is_nil(expected_generation) or generation == expected_generation ->
        case session.state.participants do
          %{^participant_session_id => folded} ->
            {:ok,
             %{
               participant_session_id: participant_session_id,
               generation: generation,
               role: folded.role,
               capabilities: Map.fetch!(session.state.role_capabilities, folded.role)
             }}

          _ ->
            {:error, :participant_inactive}
        end

      %{^participant_session_id => %{generation: generation}}
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

  defp capability(session, identity, _participant, name) do
    participant_id = normalize_id(identity.participant_session_id)
    folded_participant = session.state.participants[participant_id]
    required = required_capability(name)
    capabilities = Map.fetch!(session.state.role_capabilities, folded_participant.role)

    cond do
      name == :participant_leave ->
        :ok

      name == :transfer_host and session.state.host_participant_session_id != participant_id ->
        {:error, :capability_denied}

      required in capabilities ->
        :ok

      true ->
        {:error, :capability_denied}
    end
  end

  defp required_capability(name) when name in [:raise_hand, :lower_hand, :set_hand_raised],
    do: "raiseHand"

  defp required_capability(:set_display_name), do: "renameSelf"
  defp required_capability(:set_admission_policy), do: "manageAdmission"
  defp required_capability(:set_participant_role), do: "promoteDemote"
  defp required_capability(:transfer_host), do: "transferHost"

  defp required_capability(name) when name in [:admit_participant, :deny_admission],
    do: "manageAdmission"

  defp required_capability(:mute_participant), do: "muteOthers"
  defp required_capability(:stop_participant_camera), do: "stopVideoOthers"
  defp required_capability(:stop_participant_screen_share), do: "stopScreenOthers"
  defp required_capability(:remove_participant), do: "removeParticipant"

  defp required_capability(name) when name in [:start_recording, :stop_recording],
    do: "manageRecording"

  defp required_capability(:participant_leave), do: "self"
  defp required_capability(:end_session), do: "endMeeting"

  defp recovery_for_cursor(session, cursor, head, protocol_version) do
    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: :up_to_date, head: head, snapshot: nil, events: []}

      cursor.revision < head.revision and historical_cursor_matches?(session, cursor) ->
        replay_recovery(session, cursor.revision, head, protocol_version)

      true ->
        snapshot_recovery(session, protocol_version)
    end
  end

  defp cursor_matches_head?(cursor, head) do
    cursor.revision == head.revision and
      cursor.state_schema_version == head.state_schema_version and
      cursor.digest == head.digest
  end

  defp historical_cursor_matches?(session, cursor) do
    cursor.state_schema_version == Reducer.state_schema_version() and
      historical_digest(session, cursor.revision) == cursor.digest
  end

  defp historical_digest(session, 0),
    do: session.session.session_id |> Reducer.new() |> Reducer.digest()

  defp historical_digest(session, revision) do
    session.events
    |> :queue.to_list()
    |> Enum.find_value(fn event ->
      if event.revision == revision, do: event.resulting_state_digest
    end)
  end

  defp replay_recovery(session, revision, head, protocol_version) do
    retained = :queue.to_list(session.events)
    events = Enum.filter(retained, &(&1.revision > revision))
    oldest_revision = if match?([_ | _], retained), do: hd(retained).base_revision, else: 0

    if revision >= oldest_revision and length(events) <= 2_048 and
         Enum.sum(Enum.map(events, &(ProtocolV3.event(&1) |> byte_size()))) <= 2 * 1024 * 1024 do
      %Recovery{
        mode: :replay,
        head: head,
        snapshot: nil,
        events: [],
        replay_cursor: revision
      }
    else
      snapshot_recovery(session, protocol_version)
    end
  end

  defp bounded_recovery_page(events) do
    events
    |> Enum.reduce_while({[], 0}, fn event, {accepted, bytes} ->
      event_bytes = event |> ProtocolV3.event() |> byte_size()

      if length(accepted) < 128 and bytes + event_bytes <= 255 * 1024,
        do: {:cont, {[event | accepted], bytes + event_bytes}},
        else: {:halt, {accepted, bytes}}
    end)
    |> elem(0)
    |> Enum.reverse()
  end

  defp recover_identity(session, identity, cursor) do
    case active_participant(session, identity) do
      {:ok, _participant} -> {:ok, recovery(session, cursor, identity.protocol_version)}
      {:error, reason} -> {:ok, terminal_recovery(session, reason)}
    end
  end

  defp recovery(session, cursor), do: recovery(session, cursor, 3)

  defp recovery(session, nil, protocol_version),
    do: snapshot_recovery(session, protocol_version)

  defp recovery(
         session,
         %{revision: revision, state_schema_version: schema, digest: digest},
         protocol_version
       )
       when is_integer(revision) and revision >= 0 and is_integer(schema) and is_binary(digest) do
    head = recovery_head(session.state)

    recovery_for_cursor(
      session,
      %{revision: revision, state_schema_version: schema, digest: digest},
      head,
      protocol_version
    )
  end

  defp recovery(session, _cursor, protocol_version),
    do: snapshot_recovery(session, protocol_version)

  defp snapshot_recovery(session, protocol_version) do
    mode = if session.state.status == "ended", do: :terminal, else: :snapshot

    %Recovery{
      mode: mode,
      head: recovery_head(session.state),
      snapshot:
        if(mode == :terminal, do: nil, else: Reducer.snapshot(session.state, protocol_version)),
      events: [],
      terminal_reason: if(mode == :terminal, do: :session_ended)
    }
  end

  defp terminal_recovery(session, reason) do
    %Recovery{
      mode: :terminal,
      head: recovery_head(session.state),
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
    do: {normalize_id(identity.participant_session_id), command.id}

  defp normalize_reason(:not_joined), do: :participant_inactive
  defp normalize_reason(:session_ended), do: :session_ended
  defp normalize_reason(:invalid_target), do: :invalid_target
  defp normalize_reason(:role_not_eligible), do: :role_not_eligible
  defp normalize_reason(_reason), do: :invalid_state

  defp sync_product_roles(participants, state) do
    Map.new(participants, fn {id, participant} ->
      folded = state.participants[id]
      {id, if(folded, do: %{participant | role: folded.role}, else: participant)}
    end)
  end

  defp duplicate_result(%{name: name}, _outcome) when name in [:raise_hand, :lower_hand],
    do: :duplicate

  defp duplicate_result(_command, outcome), do: outcome

  defp normalize_id(nil), do: nil
  defp normalize_id(value) when is_binary(value), do: String.downcase(value)
end
