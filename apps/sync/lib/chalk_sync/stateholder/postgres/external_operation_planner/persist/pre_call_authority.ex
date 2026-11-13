defmodule ChalkSync.Stateholder.Postgres.ExternalOperationPlanner.Persist.PreCallAuthority do
  @moduledoc """
  Records the authority facts an accepted external operation installs before its provider call: fences, leaving or ending marks and admission or recording decisions.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationPlanner, as: SQL
  alias ChalkSync.UUID

  def persist_pre_call_authority(connection, episode, external, state, context) do
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
        [
          Scope.uuid(external.target_participant_id),
          external.target_participant_generation,
          external.name == :participant_leave,
          external.payload["entryGeneration"]
        ]

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
          Scope.nullable_dump(external.actor_participant_id),
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
        ExternalOperationFinalizer.Products.persist_event(
          connection,
          episode,
          external,
          event,
          next_state
        )

        next_state

      {:error, reason} ->
        Postgrex.rollback(connection, {:error, reason})
    end
  end
end
