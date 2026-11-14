defmodule ChalkSync.Stateholder.Postgres.RoleTransitionSettlement do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.PublicationFences
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionSettlement, as: SQL
  alias ChalkSync.UUID

  # A source stop settles only as applied. The role change took effect when it was committed, so
  # no outcome may reject it afterwards; a stop Sync cannot finish stays pending.
  def settle_child(connection, episode, child_id) do
    params = Scope.episode(episode) ++ [Scope.uuid(child_id)]

    parent_id =
      case Postgrex.query!(connection, SQL.apply_role_transition_child(), params).rows do
        [[id]] -> id
        [] -> Postgrex.rollback(connection, {:error, :invalid_state})
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

    if statuses != [] and Enum.all?(statuses, &(&1 == "applied")),
      do: apply_role_transition_parent(connection, episode, parent, parent_id, params),
      else: :pending
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
