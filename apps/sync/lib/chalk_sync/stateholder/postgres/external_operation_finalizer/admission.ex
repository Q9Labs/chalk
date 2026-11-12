defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Admission do
  @moduledoc """
  Admission rows an external operation finalizes.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.Authority
  alias ChalkSync.Stateholder.Postgres.ExternalOperationDecision
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts
  alias ChalkSync.Stateholder.Postgres.LifecycleCommit
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: LifecycleSQL
  alias ChalkSync.UUID

  def finalize_admission_approval(
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
      decision = LifecycleCommit.persist_commit(connection, episode, intent, event, next_state)
      Receipts.mark_external_applied(connection, episode, external, nil, nil)

      Receipts.commit_external_receipt(
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

  def finalize_admission_approval(
         _connection,
         _episode,
         _external,
         _state,
         _name,
         _payload
       ),
       do: {:error, :invalid_operation_outcome}


  def lock_reserved_admission_for_external(connection, episode, external) do
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


  def admission_join_payload(admission, state) do
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
          {:ok, LifecycleCommit.lock_intent(connection, episode, UUID.load!(intent_id))}
        else
          {:error, :invalid_state}
        end

      _ ->
        {:error, :invalid_state}
    end
  end


  def finalize_admission_row(connection, episode, admission_id, status, external) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(admission_id), status, Scope.uuid(external.external_operation_id)]

    case Postgrex.query!(connection, SQL.finalize_admission_request(), params).rows do
      [[_participant_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end
end
