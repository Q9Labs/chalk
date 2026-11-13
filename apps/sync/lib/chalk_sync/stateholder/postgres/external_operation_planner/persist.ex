defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Persist do
  @moduledoc """
  Writes an accepted or rejected external operation, its receipt and its pre-call authority facts inside the caller's transaction.
  """

  alias ChalkSync.Stateholder.Decision
  alias ChalkSync.Stateholder.ExternalOperation
  alias ChalkSync.Stateholder.OperationDecision
  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.CommandPersistence
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer
  alias ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Persist.PreCallAuthority
  alias ChalkSync.Stateholder.Postgres.JoinSeats
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL
  alias ChalkSync.UUID

  @pending_receipt_reserved_bytes 2_048

  def persist_operation_acceptance(connection, identity, operation, _policy, state, context) do
    external = build_external_operation(identity, operation, context)

    insert_external_operation(
      connection,
      identity.episode,
      external,
      context,
      operation.observed_context
    )

    accepted_state =
      PreCallAuthority.persist_pre_call_authority(connection, identity.episode, external, state, context)

    insert_pending_operation_receipt(connection, identity, operation, external)

    increment_pending_receipt_capacity(connection, identity.episode, accepted_state.revision)
    finalize_local_leave(connection, identity.episode, external)
  end

  def persist_internal_operation_acceptance(
         connection,
         episode,
         operation,
         _policy,
         state,
         context
       ) do
    external = build_external_operation(nil, operation, context)
    insert_external_operation(connection, episode, external, context, operation.observed_context)
    _accepted_state = PreCallAuthority.persist_pre_call_authority(connection, episode, external, state, context)
    finalize_local_leave(connection, episode, external)
  end

  defp finalize_local_leave(connection, episode, %{name: :participant_leave} = external) do
    case JoinSeats.prepare_leave(connection, episode, external.external_operation_id) do
      :ready ->
        ExternalOperationFinalizer.finalize_transaction(
          connection,
          episode,
          external.external_operation_id,
          {:confirmed, :local}
        )

      :pending ->
        ExternalOperationDecision.build(external, :original)
    end
  end

  defp finalize_local_leave(_connection, _episode, external),
    do: ExternalOperationDecision.build(external, :original)

  defp build_external_operation(identity, operation, context) do
    target = context[:target]
    observed = operation.observed_context

    %ExternalOperation{
      external_operation_id: UUID.generate(),
      request_key: operation.request_key,
      request_fingerprint: operation.fingerprint,
      name: operation.name,
      payload: persisted_operation_payload(identity, operation, context),
      status: :pending,
      attempt_count: 0,
      actor_kind: if(identity, do: "participant", else: operation.payload["actorKind"]),
      actor_id: if(identity, do: identity.participant_id, else: operation.payload["actorId"]),
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

  defp persisted_operation_payload(identity, %{name: :participant_leave} = operation, _context),
    do: Map.put(operation.payload, "entryGeneration", identity.entry_generation || 0)

  defp persisted_operation_payload(_identity, operation, context) do
    case context[:recording_reservation] do
      reservation when is_map(reservation) ->
        Map.put(operation.payload, "recording_reservation", reservation)

      _ ->
        operation.payload
    end
  end

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
      OperationTable.stored_name(external.name),
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

  def persist_operation_rejection(connection, identity, operation, reason) do
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

  defp operation_source(name) do
    case OperationTable.sources(name) do
      [source] -> Atom.to_string(source)
      _ -> nil
    end
  end
end
