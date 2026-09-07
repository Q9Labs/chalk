defmodule ChalkSync.Stateholder.Postgres.RoleTransitionSettlement do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionSettlement, as: SQL
  alias ChalkSync.UUID

  def settle_child(connection, episode, child_id, result) do
    params = Scope.episode(episode) ++ [Scope.uuid(child_id)]

    parent_id =
      case result do
        :applied ->
          case Postgrex.query!(connection, SQL.apply_role_transition_child(), params).rows do
            [[id]] -> id
            [] -> Postgrex.rollback(connection, {:error, :invalid_state})
          end

        {:failed, reason} ->
          failure_code = Atom.to_string(reason)

          case Postgrex.query!(
                 connection,
                 SQL.fail_role_transition_child(),
                 params ++ [failure_code]
               ).rows do
            [[id]] -> id
            [] -> Postgrex.rollback(connection, {:error, :invalid_state})
          end
      end

    settle_role_transition_parent(connection, episode, UUID.load!(parent_id))
  end

  defp settle_role_transition_parent(connection, episode, parent_id) do
    params = Scope.episode(episode) ++ [Scope.uuid(parent_id)]

    parent =
      case Postgrex.query!(connection, SQL.lock_role_transition_parent(), params).rows do
        [row] -> ExternalOperationRecord.from_row(row)
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
      end

    statuses =
      Postgrex.query!(connection, SQL.role_transition_child_statuses(), params).rows
      |> Enum.map(&hd/1)

    case role_transition_settlement(statuses) do
      :failed -> fail_role_transition_parent(connection, episode, parent_id, params)
      :applied -> apply_role_transition_parent(connection, episode, parent, parent_id, params)
      :pending -> :pending
    end
  end

  defp role_transition_settlement(statuses) do
    cond do
      "failed" in statuses -> :failed
      statuses != [] and Enum.all?(statuses, &(&1 == "applied")) -> :applied
      true -> :pending
    end
  end

  defp fail_role_transition_parent(connection, episode, parent_id, params) do
    case Postgrex.query!(
           connection,
           SQL.fail_role_transition_parent(),
           params ++ ["external_operation_failed"]
         ).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end

    Postgrex.query!(connection, SQL.fail_role_transition_receipt(), [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(parent_id)
    ])
  end

  defp apply_role_transition_parent(connection, episode, parent, parent_id, params) do
    case Postgrex.query!(connection, SQL.apply_role_transition_parent(), params).rows do
      [[_id]] -> :ok
      [] -> Postgrex.rollback(connection, {:error, :invalid_state})
    end

    PublicationFences.delete(connection, episode, parent)

    Postgrex.query!(connection, SQL.commit_role_transition_receipt(), [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      Scope.uuid(parent_id)
    ])
  end
end
