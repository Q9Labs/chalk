defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner do
  @moduledoc false

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.CommandDecision
  alias ChalkSync.Stateholder.Postgres.CommandPersistence
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationDecision, as: DecisionSQL
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: LifecycleSQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  @max_pending_operations 2_048
  @pending_receipt_reserved_bytes 2_048

  def accept_transaction(connection, identity, operation) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, identity.episode)
    policy = Authority.lock_episode(connection, identity.episode)
    FaultHooks.external_operation(:after_acceptance_authority_lock, identity.episode, operation)

    case fetch_operation_receipt(connection, identity, operation) do
      {:ok, row} ->
        ExternalOperationDecision.from_receipt(connection, identity, operation, row)

      :not_found ->
        participant =
          Authority.lock_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        with :ok <- Authority.validate_operation_actor(identity, operation, policy, participant),
             {:ok, state} <- Control.validate_fold(identity.episode, control, policy),
             {:ok, context} <- prepare_operation(connection, identity, operation, policy, state),
             :ok <- ensure_operation_capacity(connection, identity.episode) do
          persist_operation_acceptance(connection, identity, operation, policy, state, context)
        else
          {:error, :overloaded} ->
            Postgrex.rollback(connection, {:retryable, :overloaded})

          {:error, reason} ->
            persist_operation_rejection(
              connection,
              identity,
              operation,
              CommandDecision.terminal_reason(reason)
            )
        end
    end
  end

  def accept_internal_transaction(connection, episode, operation) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, episode)
    policy = Authority.lock_episode(connection, episode)
    FaultHooks.external_operation(:after_acceptance_authority_lock, episode, operation)

    case fetch_internal_operation(connection, episode, operation) do
      {:ok, existing} when existing.request_fingerprint != operation.fingerprint ->
        %OperationDecision{
          request_key: operation.request_key,
          result: :command_id_conflict,
          reason: :command_id_conflict
        }

      {:ok, existing} ->
        ExternalOperationDecision.build(existing, :duplicate)

      :not_found ->
        with :ok <- validate_internal_operation(operation),
             {:ok, state} <- Control.validate_fold(episode, control, policy),
             {:ok, context} <-
               prepare_internal_operation(connection, episode, operation, policy, state),
             :ok <- ensure_operation_capacity(connection, episode) do
          persist_internal_operation_acceptance(
            connection,
            episode,
            operation,
            policy,
            state,
            context
          )
        else
          {:error, :overloaded} -> Postgrex.rollback(connection, {:retryable, :overloaded})
          {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp fetch_operation_receipt(connection, identity, operation) do
    params =
      Scope.episode(identity.episode) ++
        [Scope.uuid(identity.participant_id), operation.request_key]

    case Postgrex.query!(connection, DecisionSQL.select_operation_receipt(), params).rows do
      [row] -> {:ok, row}
      [] -> :not_found
    end
  end

  defp fetch_internal_operation(connection, episode, operation) do
    params =
      Scope.episode(episode) ++ [Atom.to_string(operation.name), operation.request_key]

    case Postgrex.query!(connection, DecisionSQL.select_internal_operation(), params).rows do
      [row] -> {:ok, ExternalOperationRecord.from_row(row)}
      [] -> :not_found
    end
  end

  defp validate_internal_operation(%{name: name})
       when name in [
              :admission_request_expired,
              :tenant_set_deadline,
              :tenant_end_episode,
              :maximum_duration_expired
            ],
       do: :ok

  defp validate_internal_operation(_operation), do: {:error, :invalid_internal_operation}

  defp prepare_operation(connection, identity, operation, _policy, state) do
    case operation.name do
      name when name in [:admit_participant, :deny_admission] ->
        with {:ok, admission} <- lock_pending_admission(connection, identity.episode, operation) do
          {:ok, %{admission: admission, target: nil, sources: []}}
        end

      name
      when name in [
             :mute_participant,
             :stop_participant_camera,
             :stop_participant_screen_share,
             :remove_participant
           ] ->
        prepare_participant_target(connection, identity.episode, operation)

      :participant_leave ->
        target =
          Authority.lock_participant(
            connection,
            identity.episode,
            identity.participant_id
          )

        validate_leave_acceptance(state, target)

      name when name in [:start_recording, :stop_recording] ->
        prepare_recording(connection, identity.episode, operation, state)

      :end_episode ->
        prepare_end_operation(connection, identity.episode, nil)

      _ ->
        {:error, :invalid_state}
    end
  end

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :admission_request_expired} = op,
         _policy,
         _state
       ) do
    case lock_pending_admission(connection, episode, op) do
      {:ok, admission} ->
        if DateTime.compare(admission.expires_at, DateTime.utc_now()) in [:lt, :eq],
          do: {:ok, %{admission: admission, target: nil, sources: []}},
          else: {:error, :invalid_state}

      error ->
        error
    end
  end

  defp prepare_internal_operation(
         _connection,
         _episode,
         %{name: :tenant_set_deadline} = operation,
         policy,
         _state
       ),
       do: prepare_deadline(operation, policy)

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :tenant_end_episode},
         policy,
         _state
       ) do
    if policy.status == "active" do
      prepare_end_operation(connection, episode, nil)
    else
      {:error, :episode_ended}
    end
  end

  defp prepare_internal_operation(
         connection,
         episode,
         %{name: :maximum_duration_expired, payload: payload},
         policy,
         _state
       ) do
    supplied_generation = payload["deadlineGeneration"]
    due = DateTime.compare(policy.deadline_at, DateTime.utc_now()) in [:lt, :eq]

    cond do
      supplied_generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      policy.status != "active" || !due ->
        {:error, :episode_ended}

      true ->
        prepare_end_operation(connection, episode, supplied_generation)
    end
  end

  defp prepare_end_operation(connection, episode, deadline_generation) do
    recording_id =
      case Postgrex.query!(
             connection,
             SQL.lock_active_recording_for_end(),
             Scope.episode(episode)
           ).rows do
        [[id]] -> UUID.load!(id)
        [] -> nil
      end

    {:ok,
     %{
       target: nil,
       sources: [],
       end_episode: true,
       deadline_generation: deadline_generation,
       recording_id: recording_id
     }}
  end

  defp lock_pending_admission(connection, episode, operation) do
    request_id = operation.payload["admissionRequestId"]
    params = Scope.episode(episode) ++ [Scope.uuid(request_id)]

    case Postgrex.query!(connection, LifecycleSQL.lock_admission_request(), params).rows do
      [
        [
          id,
          participant_id,
          display_name,
          role,
          "pending",
          expires_at,
          nil
        ]
      ] ->
        {:ok,
         %{
           id: UUID.load!(id),
           participant_id: UUID.load!(participant_id),
           display_name: display_name,
           role: role,
           expires_at: expires_at
         }}

      [[_id, _participant_id, _name, _role, _status, _expires_at, _decision]] ->
        {:error, :invalid_state}

      [] ->
        {:error, :invalid_target}
    end
  end

  defp prepare_participant_target(connection, episode, operation) do
    target_id = operation.payload["participantId"]

    case Authority.lock_participant(connection, episode, target_id) do
      %{status: "active"} = target ->
        sources = operation_sources(operation.name)
        {:ok, %{target: target, sources: sources}}

      _ ->
        {:error, :invalid_target}
    end
  end

  defp validate_leave_acceptance(state, %{status: "active"} = target) do
    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => target.id,
           "reason" => "left"
         }) do
      {:change, _event, _next} ->
        {:ok, %{target: target, sources: [:microphone, :camera, :screen], leave: true}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp validate_leave_acceptance(_state, _target), do: {:error, :participant_inactive}

  defp prepare_recording(_connection, _episode, %{name: :start_recording} = operation, state) do
    recording_id = operation.payload["recordingId"]

    if is_nil(state.recording) or state.recording["status"] in ["stopped", "failed"] do
      {:ok, %{recording_id: recording_id, recording_action: :start, target: nil, sources: []}}
    else
      {:error, :recording_in_progress}
    end
  end

  defp prepare_recording(connection, episode, %{name: :stop_recording} = operation, state) do
    recording_id = operation.payload["recordingId"]
    params = Scope.episode(episode) ++ [Scope.uuid(recording_id)]

    case Postgrex.query!(connection, SQL.lock_recording(), params).rows do
      [["recording", _generation, _start_id, nil]] ->
        if state.recording == %{
             "recording_id" => recording_id,
             "status" => "recording",
             "failure_code" => nil
           } do
          {:ok, %{recording_id: recording_id, recording_action: :stop, target: nil, sources: []}}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_target}
    end
  end

  defp prepare_deadline(operation, policy) do
    deadline_at_ms = operation.payload["deadlineAtMs"]
    generation = operation.payload["deadlineGeneration"]

    ceiling_ms =
      DateTime.to_unix(policy.created_at, :millisecond) +
        policy.maximum_duration_ceiling_seconds * 1_000

    if generation == policy.deadline_generation + 1 and deadline_at_ms <= ceiling_ms do
      {:ok,
       %{
         target: nil,
         sources: [],
         deadline_generation: generation,
         deadline_at_ms: deadline_at_ms
       }}
    else
      {:error, :invalid_state}
    end
  end

  defp ensure_operation_capacity(connection, episode) do
    case Postgrex.query!(connection, SQL.count_pending_operations(), Scope.episode(episode)).rows do
      [[count]] when count < @max_pending_operations -> :ok
      _ -> {:error, :overloaded}
    end
  end

  defp persist_operation_acceptance(connection, identity, operation, _policy, state, context) do
    external = build_external_operation(identity, operation, context)

    insert_external_operation(
      connection,
      identity.episode,
      external,
      context,
      operation.observed_context
    )

    accepted_state =
      persist_pre_call_authority(connection, identity.episode, external, state, context)

    insert_pending_operation_receipt(connection, identity, operation, external)

    increment_pending_receipt_capacity(connection, identity.episode, accepted_state.revision)
    ExternalOperationDecision.build(external, :original)
  end

  defp persist_internal_operation_acceptance(
         connection,
         episode,
         operation,
         _policy,
         state,
         context
       ) do
    external = build_external_operation(nil, operation, context)
    insert_external_operation(connection, episode, external, context, operation.observed_context)
    _accepted_state = persist_pre_call_authority(connection, episode, external, state, context)
    ExternalOperationDecision.build(external, :original)
  end

  defp build_external_operation(identity, operation, context) do
    target = context[:target]
    observed = operation.observed_context

    %ExternalOperation{
      external_operation_id: UUID.generate(),
      request_key: operation.request_key,
      request_fingerprint: operation.fingerprint,
      name: operation.name,
      payload: operation.payload,
      status: :pending,
      attempt_count: 0,
      actor_participant_id: identity && identity.participant_id,
      actor_generation: identity && identity.participant_generation,
      target_participant_id: optional_field(target, :id),
      target_participant_generation: optional_field(target, :generation),
      recording_id: context[:recording_id],
      deadline_generation: context[:deadline_generation],
      journey_id: optional_field(observed, :journey_id),
      parent_journey_event_id: optional_field(observed, :parent_journey_event_id),
      producing_trace_id: optional_field(observed, :producing_trace_id),
      producing_span_id: optional_field(observed, :producing_span_id),
      producing_traceparent: optional_field(observed, :producing_traceparent),
      producing_tracestate: optional_field(observed, :producing_tracestate)
    }
  end

  defp optional_field(nil, _field), do: nil
  defp optional_field(value, field), do: Map.get(value, field)

  defp insert_external_operation(connection, episode, external, context, observed) do
    source = operation_source(external.name)
    fence_active = context.sources != [] || context[:end_episode] == true

    Postgrex.query!(connection, SQL.insert_external_operation(), [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.space_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(external.external_operation_id),
      external.request_key,
      external.request_fingerprint,
      operation_name_string(external.name),
      Scope.nullable_dump(external.actor_participant_id),
      external.actor_generation,
      Scope.nullable_dump(external.target_participant_id),
      external.target_participant_generation,
      source,
      Scope.nullable_dump(external.recording_id),
      external.deadline_generation,
      Scope.nullable_dump(external.journey_id),
      Scope.nullable_dump(external.parent_journey_event_id),
      external.producing_trace_id,
      external.producing_span_id,
      external.producing_traceparent,
      external.producing_tracestate,
      external.payload,
      fence_active
    ])

    insert_external_operation_journey_event(connection, external, observed)
  end

  defp operation_name_string(:maximum_duration_expired), do: "maximum_episode_duration_expired"
  defp operation_name_string(name), do: Atom.to_string(name)

  defp insert_external_operation_journey_event(_connection, _external, nil), do: :ok

  defp insert_external_operation_journey_event(connection, external, observed) do
    Postgrex.query!(connection, SQL.insert_external_operation_journey_event(), [
      Scope.uuid(observed.parent_journey_event_id),
      Scope.uuid(observed.journey_id),
      observed.occurred_at,
      "visible",
      observed.producing_trace_id,
      observed.producing_span_id,
      %{
        "external_operation_id" => external.external_operation_id,
        "operation" => Atom.to_string(external.name)
      }
    ])
  end

  defp persist_pre_call_authority(connection, episode, external, state, context) do
    reserve_admission_decision(connection, episode, external, context[:admission])

    participants =
      if context[:end_episode],
        do: lock_all_operation_participants(connection, episode),
        else: List.wrap(context[:target])

    install_operation_fences(connection, episode, external, participants, context)

    cond do
      context[:recording_action] == :start ->
        accept_recording_start(connection, episode, external)
        persist_acceptance_fact(connection, episode, external, state, "starting")

      context[:recording_action] == :stop ->
        accept_recording_stop(connection, episode, external)
        persist_acceptance_fact(connection, episode, external, state, "stopping")

      context[:leave] || external.name == :remove_participant ->
        mark_operation_participant_leaving(connection, episode, external)
        state

      context[:end_episode] ->
        mark_operation_episode_ending(connection, episode)
        state

      true ->
        state
    end
  end

  defp reserve_admission_decision(_connection, _episode, _external, nil), do: :ok

  defp reserve_admission_decision(connection, episode, external, admission) do
    participant_id = Scope.uuid(admission.participant_id)

    params =
      Scope.episode(episode) ++
        [Scope.uuid(admission.id), Scope.uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.reserve_admission_request(), params).rows do
      [[^participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp lock_all_operation_participants(connection, episode) do
    Postgrex.query!(connection, SQL.lock_active_participants(), Scope.episode(episode)).rows
    |> Enum.map(fn [id, generation, role, capabilities] ->
      %{
        id: UUID.load!(id),
        generation: generation,
        status: "active",
        role: role,
        capabilities: capabilities
      }
    end)
  end

  defp install_operation_fences(connection, episode, external, participants, context) do
    sources = if context[:end_episode], do: [:microphone, :camera, :screen], else: context.sources

    Enum.each(
      participants,
      &PublicationFences.install(connection, episode, external, &1, sources)
    )
  end

  defp mark_operation_participant_leaving(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.mark_participant_leaving(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_target})
    end
  end

  defp mark_operation_episode_ending(connection, episode) do
    case Postgrex.query!(connection, SQL.mark_episode_ending(), Scope.episode(episode)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :episode_ended})
    end
  end

  defp accept_recording_start(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [
          Scope.uuid(external.recording_id),
          Scope.uuid(external.actor_participant_id),
          external.actor_generation,
          Scope.uuid(external.external_operation_id)
        ]

    case Postgrex.query!(connection, SQL.insert_recording_reservation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :recording_in_progress})
    end
  end

  defp accept_recording_stop(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.recording_id), Scope.uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.accept_recording_stop(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_target})
    end
  end

  defp persist_acceptance_fact(connection, episode, external, state, status) do
    payload = %{
      "recording_id" => external.recording_id,
      "status" => status,
      "failure_code" => nil
    }

    case Reducer.apply_external(state, :recording_status_changed, payload) do
      {:ok, event, next_state} ->
        ExternalOperationFinalizer.persist_event(connection, episode, external, event, next_state)
        next_state

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp insert_pending_operation_receipt(connection, identity, operation, external) do
    Postgrex.query!(connection, SQL.insert_pending_operation_receipt(), [
      Scope.uuid(identity.episode.tenant_id),
      Scope.uuid(identity.episode.episode_id),
      Scope.uuid(identity.participant_id),
      identity.participant_generation,
      operation.request_key,
      operation.fingerprint,
      Atom.to_string(operation.name),
      Scope.uuid(external.external_operation_id)
    ])
  end

  defp increment_pending_receipt_capacity(connection, episode, revision) do
    params = Scope.episode(episode) ++ [@pending_receipt_reserved_bytes]

    case Postgrex.query!(connection, SQL.increment_pending_operation_capacity(), params).rows do
      [[^revision]] -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp persist_operation_rejection(connection, identity, operation, reason) do
    command = operation_as_command(operation)

    CommandPersistence.reject(connection, identity, command, reason)
    |> operation_rejection_from_command(operation)
  end

  defp operation_as_command(operation) do
    %{
      id: operation.request_key,
      name: operation.name,
      fingerprint: operation.fingerprint,
      payload: operation.payload
    }
  end

  defp operation_rejection_from_command(%Decision{} = decision, operation) do
    %OperationDecision{
      request_key: operation.request_key,
      result: decision.result,
      reason: decision.reason
    }
  end

  defp operation_sources(:mute_participant), do: [:microphone]
  defp operation_sources(:stop_participant_camera), do: [:camera]
  defp operation_sources(:stop_participant_screen_share), do: [:screen]
  defp operation_sources(:remove_participant), do: [:microphone, :camera, :screen]

  defp operation_source(:mute_participant), do: "microphone"
  defp operation_source(:stop_participant_camera), do: "camera"
  defp operation_source(:stop_participant_screen_share), do: "screen"
  defp operation_source(_name), do: nil
end
