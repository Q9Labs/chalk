defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Products do
  @moduledoc """
  Control, event and product rows an external operation updates.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Admission
  alias ChalkSync.Stateholder.Postgres.LifecycleCommit
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  alias ChalkSync.Stateholder.Postgres.SQL.Lifecycle, as: LifecycleSQL
  alias ChalkSync.Stateholder.Postgres.WebhookObservation
  alias ChalkSync.UUID
  require OperationTable

  @max_event_bytes 32 * 1024
  @schema_version 1

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


  def update_external_products(connection, episode, external, _event, _state)
       when external.name in [:remove_participant, :participant_leave] do
    complete_external_participant(connection, episode, external)
  end

  def update_external_products(connection, episode, external, _event, _state)
       when OperationTable.is_episode_end_name(external.name) do
    complete_external_episode(connection, episode, external)
  end

  def update_external_products(connection, episode, %{name: name} = external, _event, _state)
       when name in [:deny_admission, :admission_request_expired] do
    status = if name == :deny_admission, do: "denied", else: "expired"

    case Admission.lock_reserved_admission_for_external(connection, episode, external) do
      {:ok, admission} ->
        Admission.finalize_admission_row(connection, episode, admission.id, status, external)
        complete_denied_admission_product(connection, episode, admission)

      _ ->
        Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def update_external_products(
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

  def update_external_products(connection, episode, %{name: name} = external, event, _state)
       when name in [
              :recording_capture_ready,
              :recording_capture_stopped,
              :recording_capture_failed
            ],
       do:
         finalize_recording_product(
           connection,
           episode,
           external,
           event.payload["status"],
           event.payload["failure_code"]
         )

  def update_external_products(
         connection,
         episode,
         %{name: :tenant_set_deadline} = external,
         _event,
         _state
       ),
       do: update_deadline_product(connection, episode, external)

  def update_external_products(_connection, _episode, _external, _event, _state), do: :ok


  defp complete_denied_admission_product(connection, episode, admission) do
    params = Scope.episode(episode) ++ [Scope.uuid(admission.participant_id)]

    Postgrex.query!(connection, SQL.supersede_admission_join_intent(), params)
    Postgrex.query!(connection, SQL.complete_admission_participant(), params)
    :ok
  end


  defp complete_external_participant(connection, episode, external) do
    params =
      Scope.episode(episode) ++
        [
          Scope.uuid(external.target_participant_id),
          external.target_participant_generation,
          external.name == :participant_leave,
          external.payload["entryGeneration"],
          Scope.uuid(external.external_operation_id)
        ]

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

    LifecycleCommit.complete_episode_participants(
      connection,
      episode,
      external,
      webhook_object.ended_at
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


  def finalize_recording_product(connection, episode, external, "failed", failure_code) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.recording_id), failure_code]

    case Postgrex.query!(connection, SQL.fail_recording(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def finalize_recording_product(connection, episode, external, status, failure_code) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.recording_id), status, failure_code]

    case Postgrex.query!(connection, SQL.finalize_recording(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end
end
