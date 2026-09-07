defmodule ChalkSync.Stateholder.Postgres.PublicationFences do
  @moduledoc false

  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionPlanner, as: PlannerSQL
  alias ChalkSync.Stateholder.Postgres.SQL.RoleTransitionSettlement, as: SettlementSQL

  def install(_connection, _episode, _external, nil, _sources), do: :ok

  def install(connection, episode, external, participant, sources) do
    Enum.each(sources, fn source ->
      operation_id = Scope.uuid(external.external_operation_id)

      params =
        Scope.episode(episode) ++
          [
            Scope.uuid(participant.id),
            participant.generation,
            Atom.to_string(source),
            operation_id
          ]

      case Postgrex.query!(connection, PlannerSQL.insert_publication_fence(), params).rows do
        [[^operation_id]] -> :ok
        _ -> Postgrex.rollback(connection, {:error, :invalid_state})
      end
    end)
  end

  def delete(connection, episode, external) do
    Postgrex.query!(
      connection,
      SettlementSQL.delete_operation_fences(),
      Scope.episode(episode) ++ [Scope.uuid(external.external_operation_id)]
    )
  end
end
