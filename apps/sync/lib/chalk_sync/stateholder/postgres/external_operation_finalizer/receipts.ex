defmodule ChalkSync.Stateholder.Postgres.ExternalOperationFinalizer.Receipts do
  @moduledoc """
  Receipt and status writes that close an external operation.
  """

  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.OperationTable
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationFinalizer, as: SQL
  require OperationTable

  def release_failed_acceptance(connection, episode, external)
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

  def release_failed_acceptance(connection, episode, external)
      when external.name in [:remove_participant, :participant_leave] do
    params =
      Scope.episode(episode) ++
        [
          Scope.uuid(external.target_participant_id),
          external.target_participant_generation,
          external.name == :participant_leave,
          external.payload["entryGeneration"]
        ]

    case Postgrex.query!(connection, SQL.restore_participant_active(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def release_failed_acceptance(connection, episode, external)
      when OperationTable.is_episode_end_name(external.name) do
    case Postgrex.query!(connection, SQL.restore_episode_active(), Scope.episode(episode)).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def release_failed_acceptance(_connection, _episode, _external), do: :ok

  def mark_external_applied(connection, episode, external, event_id, revision) do
    params =
      Scope.episode(episode) ++
        [Scope.uuid(external.external_operation_id), Scope.nullable_dump(event_id), revision]

    case Postgrex.query!(connection, SQL.apply_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def mark_external_failed(connection, episode, external, failure_code) do
    params = Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id), failure_code]

    case Postgrex.query!(connection, SQL.fail_external_operation(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end
  end

  def commit_external_receipt(connection, episode, external, event_id, revision, state) do
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

  def reject_external_receipt(connection, episode, external) do
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
