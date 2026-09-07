defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer do
  @moduledoc false

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.FaultHooks
  alias ChalkSync.Stateholder.Postgres.Lifecycle
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.RoleTransitionSettlement
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: LifecycleSQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.UUID
  alias ChalkSync.Webhooks.Producer, as: WebhookProducer

  @max_event_bytes 32 * 1024
  @schema_version 1

  def finalize_transaction(connection, episode, external_operation_id, outcome) do
    Transaction.configure(connection)
    control = Authority.lock_control(connection, episode)
    policy = Authority.lock_episode(connection, episode)
    external = lock_external_operation(connection, episode, external_operation_id)

    cond do
      external.status != :pending ->
        ExternalOperationDecision.build(external, :duplicate)

      stale_maximum_duration?(external, policy) ->
        settle_stale_maximum_duration(connection, episode, external)

      true ->
        with {:ok, state} <- Control.validate_fold(episode, control, policy),
             :ok <- validate_finalization_authority(connection, episode, external, policy) do
          finalize_pending_operation(connection, episode, external, state, outcome)
        else
          {:error, reason} -> Postgrex.rollback(connection, {:error, reason})
        end
    end
  end

  defp stale_maximum_duration?(%{name: :maximum_duration_expired} = external, policy) do
    external.deadline_generation != policy.deadline_generation ||
      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt
  end

  defp stale_maximum_duration?(_external, _policy), do: false

  defp settle_stale_maximum_duration(connection, episode, external) do
    release_failed_acceptance(connection, episode, external)
    PublicationFences.delete(connection, episode, external)
    mark_external_failed(connection, episode, external, "stale_deadline_generation")

    failed = %{
      external
      | status: :failed,
        last_error_code: :stale_deadline_generation
    }

    ExternalOperationDecision.build(failed, :original)
  end

  defp lock_external_operation(connection, episode, external_operation_id) do
    params = Scope.episode(episode) ++ [Scope.uuid(external_operation_id)]

    case Postgrex.query!(connection, SQL.lock_operation(), params).rows do
      [row] -> ExternalOperationRecord.from_row(row)
      [] -> Postgrex.rollback(connection, {:error, :operation_not_found})
    end
  end

  defp validate_finalization_authority(connection, episode, external, policy) do
    with :ok <- validate_finalization_episode(external, policy),
         :ok <- validate_finalization_participant(connection, episode, external, :actor),
         :ok <- validate_finalization_participant(connection, episode, external, :target) do
      validate_finalization_deadline(external, policy)
    end
  end

  defp validate_finalization_episode(%{name: name}, %{status: "ending"})
       when name in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: :ok

  defp validate_finalization_episode(%{name: name}, %{status: "active"})
       when name not in [:end_episode, :tenant_end_episode, :maximum_duration_expired],
       do: :ok

  defp validate_finalization_episode(_external, _policy), do: {:error, :episode_ended}

  defp validate_finalization_participant(_connection, _episode, external, field)
       when field == :actor and is_nil(external.actor_participant_id),
       do: :ok

  defp validate_finalization_participant(_connection, _episode, external, field)
       when field == :target and is_nil(external.target_participant_id),
       do: :ok

  defp validate_finalization_participant(connection, episode, external, field) do
    {participant_id, generation} =
      case field do
        :actor ->
          {external.actor_participant_id, external.actor_generation}

        :target ->
          {external.target_participant_id, external.target_participant_generation}
      end

    case Authority.lock_participant(connection, episode, participant_id) do
      %{generation: ^generation, status: status}
      when status in ["active", "leaving", "joining"] ->
        :ok

      %{generation: _other} ->
        {:error, :stale_participant_generation}

      _ ->
        {:error, :participant_inactive}
    end
  end

  defp validate_finalization_deadline(
         %{name: :tenant_set_deadline, deadline_generation: generation},
         policy
       ) do
    if generation == policy.deadline_generation + 1,
      do: :ok,
      else: {:error, :stale_deadline_generation}
  end

  defp validate_finalization_deadline(
         %{name: :maximum_duration_expired, deadline_generation: generation},
         policy
       ) do
    cond do
      generation != policy.deadline_generation ->
        {:error, :stale_deadline_generation}

      DateTime.compare(policy.deadline_at, DateTime.utc_now()) == :gt ->
        {:error, :stale_deadline_generation}

      true ->
        :ok
    end
  end

  defp validate_finalization_deadline(_external, _policy), do: :ok

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :admit_participant} = external,
         state,
         {:confirmed, :local}
       ) do
    with {:ok, admission} <- lock_reserved_admission_for_external(connection, episode, external) do
      finalize_admission_approval(
        connection,
        episode,
        external,
        state,
        :participant_joined,
        admission_join_payload(admission, state)
      )
    end
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :local}
       )
       when name in [:deny_admission, :admission_request_expired, :tenant_set_deadline],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :provider}
       )
       when name in [
              :mute_participant,
              :stop_participant_camera,
              :stop_participant_screen_share,
              :remove_participant,
              :participant_leave,
              :end_episode,
              :tenant_end_episode,
              :maximum_duration_expired
            ],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: name} = external,
         state,
         {:confirmed, :recording}
       )
       when name in [:start_recording, :stop_recording],
       do: finalize_confirmed_operation(connection, episode, external, state)

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:confirmed, _provider}
       ) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      :applied
    )

    ExternalOperationDecision.build(%{external | status: :applied}, :original)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:applied, _name, _payload}
       ) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      :applied
    )

    ExternalOperationDecision.build(%{external | status: :applied}, :original)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         %{name: :role_transition_source_stop} = external,
         _state,
         {:failed, reason}
       )
       when is_atom(reason) do
    RoleTransitionSettlement.settle_child(
      connection,
      episode,
      external.external_operation_id,
      {:failed, reason}
    )

    ExternalOperationDecision.build(
      %{external | status: :failed, last_error_code: reason},
      :original
    )
  end

  defp finalize_pending_operation(connection, episode, external, state, {:failed, reason})
       when is_atom(reason) do
    failure_code = Atom.to_string(reason)

    if byte_size(failure_code) > 96 do
      Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end

    state = maybe_persist_recording_failure(connection, episode, external, state, failure_code)
    release_failed_acceptance(connection, episode, external)
    PublicationFences.delete(connection, episode, external)
    mark_external_failed(connection, episode, external, failure_code)
    reject_external_receipt(connection, episode, external)

    failed = %{external | status: :failed, last_error_code: reason}
    ExternalOperationDecision.build(failed, :original, state)
  end

  defp finalize_pending_operation(
         connection,
         episode,
         external,
         state,
         {:applied, name, payload}
       )
       when is_atom(name) and is_map(payload) do
    if external.name == :admit_participant do
      finalize_admission_approval(connection, episode, external, state, name, payload)
    else
      finalize_external_fact(connection, episode, external, state, name, payload)
    end
  end

  defp finalize_pending_operation(connection, _episode, _external, _state, _outcome),
    do: Postgrex.rollback(connection, {:error, :invalid_operation_outcome})

  defp finalize_confirmed_operation(connection, episode, external, state) do
    case local_operation_outcome(external, state) do
      {:ok, event_name, payload} ->
        finalize_pending_operation(
          connection,
          episode,
          external,
          state,
          {:applied, event_name, payload}
        )

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end

  defp local_operation_outcome(%{name: name} = external, state)
       when name in [:participant_leave, :remove_participant] do
    reason = if name == :participant_leave, do: "left", else: "removed"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, _next_state} ->
        {:ok, String.to_existing_atom(event.name), event.payload}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp local_operation_outcome(external, state) do
    case expected_fact(external, state) do
      {name, payload} -> {:ok, name, payload}
      :invalid -> {:error, :invalid_operation_outcome}
    end
  end

  defp finalize_external_fact(connection, episode, external, state, name, payload) do
    case expected_external_fact(external, state, name, payload) do
      {:ok, event, next_state} ->
        event_id = persist_event(connection, episode, external, event, next_state)

        webhook_object =
          update_external_products(connection, episode, external, event, next_state)

        PublicationFences.delete(connection, episode, external)
        mark_external_applied(connection, episode, external, event_id, event.revision)

        commit_external_receipt(
          connection,
          episode,
          external,
          event_id,
          event.revision,
          next_state
        )

        WebhookProducer.produce_external(connection, episode, external, event, webhook_object)
        FaultHooks.external_operation(:after_webhook_production, episode, external)
        Control.notify_head(connection, episode, event.revision)

        applied = %{
          external
          | status: :applied,
            applied_event_id: event_id,
            applied_revision: event.revision
        }

        ExternalOperationDecision.build(applied, :original, next_state)

      {:error, _reason} ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp finalize_admission_approval(
         connection,
         episode,
         external,
         state,
         :participant_joined,
         payload
       ) do
    with {:ok, admission} <- lock_reserved_admission_for_external(connection, episode, external),
         true <- payload == admission_join_payload(admission, state),
         {:ok, intent} <- lock_admission_join_intent(connection, episode, admission),
         {:ok, event, next_state} <-
           Reducer.apply_lifecycle(state, :participant_joined, payload) do
      finalize_admission_row(connection, episode, admission.id, "admitted", external)
      decision = Lifecycle.persist_commit(connection, episode, intent, event, next_state)
      mark_external_applied(connection, episode, external, nil, nil)

      commit_external_receipt(
        connection,
        episode,
        external,
        decision.event_id,
        decision.revision,
        next_state
      )

      applied = %{external | status: :applied}

      ExternalOperationDecision.build(
        applied,
        :original,
        next_state,
        decision.event_id,
        decision.revision
      )
    else
      _ -> Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp finalize_admission_approval(
         _connection,
         _episode,
         _external,
         _state,
         _name,
         _payload
       ),
       do: {:error, :invalid_operation_outcome}

  defp lock_reserved_admission_for_external(connection, episode, external) do
    request_id = external.payload["admissionRequestId"]
    operation_id = Scope.uuid(external.external_operation_id)
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
          ^operation_id
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

      _ ->
        {:error, :invalid_state}
    end
  end

  defp admission_join_payload(admission, state) do
    %{
      "participant_id" => admission.participant_id,
      "display_name" => admission.display_name,
      "role" => admission.role,
      "admission_revision" => state.revision + 1
    }
  end

  defp lock_admission_join_intent(connection, episode, admission) do
    params = Scope.episode(episode) ++ [Scope.uuid(admission.participant_id)]

    case Postgrex.query!(connection, SQL.lock_admission_lifecycle_intent(), params).rows do
      [[intent_id, "pending", generation]] ->
        participant =
          Authority.lock_participant(connection, episode, admission.participant_id)

        if participant && participant.generation == generation && participant.status == "joining" &&
             participant.role == admission.role do
          {:ok, Lifecycle.lock_intent(connection, episode, UUID.load!(intent_id))}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_state}
    end
  end

  defp expected_external_fact(external, state, name, payload)
       when external.name in [:remove_participant, :participant_leave] do
    reason = if external.name == :remove_participant, do: "removed", else: "left"

    case Reducer.decide_external(state, :participant_leave, %{
           "participant_id" => external.target_participant_id,
           "reason" => reason
         }) do
      {:change, event, next_state} ->
        if name == String.to_existing_atom(event.name) and payload == event.payload,
          do: {:ok, event, next_state},
          else: {:error, :invalid_operation_outcome}

      error ->
        error
    end
  end

  defp expected_external_fact(external, state, name, payload) do
    expected = expected_fact(external, state)

    if expected == {name, payload} do
      Reducer.apply_external(state, name, payload)
    else
      {:error, :invalid_operation_outcome}
    end
  end

  defp expected_fact(%{name: :deny_admission} = external, _state),
    do: {:admission_denied, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :admission_request_expired} = external, _state),
    do: {:admission_expired, %{"admission_request_id" => external.payload["admissionRequestId"]}}

  defp expected_fact(%{name: :mute_participant} = external, _state),
    do: {:participant_microphone_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_camera} = external, _state),
    do: {:participant_camera_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: :stop_participant_screen_share} = external, _state),
    do: {:participant_screen_share_stopped, %{"participant_id" => external.target_participant_id}}

  defp expected_fact(%{name: name} = external, _state)
       when name in [:start_recording, :stop_recording] do
    terminal_status = if name == :start_recording, do: "recording", else: "stopped"

    {:recording_status_changed,
     %{
       "recording_id" => external.recording_id,
       "status" => terminal_status,
       "failure_code" => nil
     }}
  end

  defp expected_fact(%{name: :end_episode}, _state),
    do: {:episode_ended, %{"reason" => "ended_by_participant"}}

  defp expected_fact(%{name: :tenant_end_episode}, _state),
    do: {:episode_ended, %{"reason" => "tenant_recovery"}}

  defp expected_fact(%{name: :maximum_duration_expired}, _state),
    do: {:episode_ended, %{"reason" => "maximum_duration"}}

  defp expected_fact(%{name: :tenant_set_deadline} = external, _state),
    do:
      {:deadline_changed,
       %{
         "deadline_at_ms" => external.payload["deadlineAtMs"],
         "deadline_generation" => external.deadline_generation
       }}

  defp expected_fact(_external, _state), do: :invalid

  def persist_event(connection, episode, external, event, state) do
    event_id = UUID.generate()
    digest = Reducer.digest(state)

    stored_event =
      event
      |> Map.put(:event_id, event_id)
      |> Map.put(:command_id, nil)
      |> Map.put(:lifecycle_intent_id, nil)
      |> Map.put(:external_operation_id, external.external_operation_id)
      |> Map.put(:actor_participant_id, external.actor_participant_id)
      |> Map.put(:actor_generation, external.actor_generation)
      |> Map.put(:schema_version, @schema_version)
      |> Map.put(:resulting_state_digest, digest)

    event_bytes = Control.encoded_event_bytes(stored_event)

    if event_bytes > @max_event_bytes do
      Postgrex.rollback(connection, {:retryable, :overloaded})
    end

    Postgrex.query!(connection, SQL.insert_external_event(), [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.space_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(event_id),
      event.base_revision,
      event.revision,
      event.name,
      event.payload,
      Scope.nullable_dump(external.actor_participant_id),
      external.actor_generation,
      Scope.uuid(external.external_operation_id),
      @schema_version,
      digest,
      event_bytes
    ])

    update_external_control(connection, episode, external, state, event_bytes)
    event_id
  end

  defp update_external_control(connection, episode, external, state, event_bytes) do
    params =
      Scope.episode(episode) ++
        [
          state.revision,
          Reducer.snapshot(state),
          Reducer.state_schema_version(),
          Reducer.digest(state),
          Reducer.snapshot_bytes(state),
          event_bytes
        ]

    query =
      cond do
        state.status == "ended" ->
          SQL.update_external_end_control()

        external.name in [:deny_admission, :admission_request_expired] ->
          SQL.update_external_admission_control()

        true ->
          SQL.update_external_control()
      end

    case Postgrex.query!(connection, query, params).rows do
      [[revision]] when revision == state.revision -> :ok
      [] -> Postgrex.rollback(connection, {:retryable, :overloaded})
    end
  end

  defp update_external_products(connection, episode, external, _event, _state)
       when external.name in [:remove_participant, :participant_leave] do
    complete_external_participant(connection, episode, external)
  end

  defp update_external_products(connection, episode, external, _event, _state)
       when external.name in [:end_episode, :tenant_end_episode, :maximum_duration_expired] do
    complete_external_episode(connection, episode, external)
  end

  defp update_external_products(connection, episode, %{name: name} = external, _event, _state)
       when name in [:deny_admission, :admission_request_expired] do
    status = if name == :deny_admission, do: "denied", else: "expired"

    case lock_reserved_admission_for_external(connection, episode, external) do
      {:ok, admission} ->
        finalize_admission_row(connection, episode, admission.id, status, external)
        complete_denied_admission_product(connection, episode, admission)

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp update_external_products(
         connection,
         episode,
         %{name: :stop_participant_screen_share} = external,
         _event,
         _state
       ) do
    Postgrex.query!(
      connection,
      SQL.release_screen_share_lease(),
      Scope.episode(episode) ++
        [Scope.uuid(external.target_participant_id), external.target_participant_generation]
    )
  end

  defp update_external_products(connection, episode, %{name: name} = external, event, _state)
       when name in [:start_recording, :stop_recording],
       do: finalize_recording_product(connection, episode, external, event.payload["status"], nil)

  defp update_external_products(
         connection,
         episode,
         %{name: :tenant_set_deadline} = external,
         _event,
         _state
       ),
       do: update_deadline_product(connection, episode, external)

  defp update_external_products(_connection, _episode, _external, _event, _state), do: :ok

  defp finalize_admission_row(connection, episode, admission_id, status, external) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(admission_id), status, Scope.uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.finalize_admission_request(), params).rows do
      [[_participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp complete_denied_admission_product(connection, episode, admission) do
    params = Scope.episode(episode) ++ [Scope.uuid(admission.participant_id)]

    Postgrex.query!(connection, SQL.supersede_admission_join_intent(), params)
    Postgrex.query!(connection, SQL.complete_admission_participant(), params)
    :ok
  end

  defp complete_external_participant(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.complete_external_participant(), params).rows do
      [row] ->
        WebhookObservation.participant_object(row)

      [] ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp complete_external_episode(connection, episode, external) do
    webhook_object =
      case Postgrex.query!(connection, SQL.complete_external_episode(), Scope.episode(episode)).rows do
        [[id, space_id, status, started_at, ended_at, created_at, updated_at]] ->
          %{
            id: UUID.load!(id),
            space_id: UUID.load!(space_id),
            status: status,
            started_at: started_at,
            ended_at: ended_at,
            created_at: created_at,
            updated_at: updated_at
          }

        [] ->
          Postgrex.rollback(connection, {:error, :invalid_state})
      end

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_participants(),
      Scope.episode(episode)
    )

    Postgrex.query!(
      connection,
      LifecycleSQL.supersede_pending_lifecycle_intents(),
      Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id)]
    )

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_admissions(),
      Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id)]
    )

    Postgrex.query!(
      connection,
      SQL.complete_external_episode_recordings(),
      Scope.episode(episode)
    )

    webhook_object
  end

  defp update_deadline_product(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [external.payload["deadlineAtMs"], external.deadline_generation]

    case Postgrex.query!(connection, SQL.update_episode_deadline(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :stale_deadline_generation})
    end
  end

  defp finalize_recording_product(connection, episode, external, status, failure_code) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.recording_id), status, failure_code]

    case Postgrex.query!(connection, SQL.finalize_recording(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp maybe_persist_recording_failure(connection, episode, external, state, failure_code)
       when external.name in [:start_recording, :stop_recording] do
    payload = %{
      "recording_id" => external.recording_id,
      "status" => "failed",
      "failure_code" => failure_code
    }

    case Reducer.apply_external(state, :recording_status_changed, payload) do
      {:ok, event, next_state} ->
        _event_id = persist_event(connection, episode, external, event, next_state)
        finalize_recording_product(connection, episode, external, "failed", failure_code)
        Control.notify_head(connection, episode, event.revision)
        next_state

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_operation_outcome})
    end
  end

  defp maybe_persist_recording_failure(_connection, _episode, _external, state, _failure_code),
    do: state

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:admit_participant, :deny_admission, :admission_request_expired] do
    params =
      Scope.episode(episode) ++
        [
          Scope.uuid(external.payload["admissionRequestId"]),
          Scope.uuid(external.external_operation_id)
        ]

    case Postgrex.query!(connection, SQL.release_admission_request_reservation(), params).rows do
      [[_participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:remove_participant, :participant_leave] do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.target_participant_id), external.target_participant_generation]

    case Postgrex.query!(connection, SQL.restore_participant_active(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(connection, episode, external)
       when external.name in [:end_episode, :tenant_end_episode, :maximum_duration_expired] do
    case Postgrex.query!(connection, SQL.restore_episode_active(), Scope.episode(episode)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp release_failed_acceptance(_connection, _episode, _external), do: :ok

  defp mark_external_applied(connection, episode, external, event_id, revision) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.external_operation_id), Scope.nullable_dump(event_id), revision]

    case Postgrex.query!(connection, SQL.apply_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp mark_external_failed(connection, episode, external, failure_code) do
    params = Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id), failure_code]

    case Postgrex.query!(connection, SQL.fail_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  defp commit_external_receipt(connection, episode, external, event_id, revision, state) do
    if external.actor_participant_id do
      params = [
        Scope.uuid(episode.tenant_id),
        Scope.uuid(episode.episode_id),
        Scope.uuid(external.actor_participant_id),
        external.request_key,
        Scope.uuid(external.external_operation_id),
        Scope.uuid(event_id),
        revision,
        Reducer.digest(state)
      ]

      case Postgrex.query!(connection, SQL.commit_operation_receipt(), params).rows do
        [[_command_id]] -> :ok
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end
  end

  defp reject_external_receipt(connection, episode, external) do
    if external.actor_participant_id do
      params = [
        Scope.uuid(episode.tenant_id),
        Scope.uuid(episode.episode_id),
        Scope.uuid(external.actor_participant_id),
        external.request_key,
        Scope.uuid(external.external_operation_id)
      ]

      case Postgrex.query!(connection, SQL.reject_operation_receipt(), params).rows do
        [[_command_id]] -> :ok
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end
  end
end
