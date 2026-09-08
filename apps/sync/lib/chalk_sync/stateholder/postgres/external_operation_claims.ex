defmodule ChalkSync.Stateholder.Postgres.ExternalOperationClaims do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.ExternalOperationRecord
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ExternalOperationClaims, as: SQL
  alias ChalkSync.UUID

  def claim_operations(limit) when is_integer(limit) and limit in 1..64 do
    claim_operation_rows(SQL.claim_operations(), limit)
  end

  def claim_local_operations(limit) when is_integer(limit) and limit in 1..64 do
    claim_operation_rows(SQL.claim_local_operations(), limit)
  end

  defp claim_operation_rows(query, limit) do
    episode = %EpisodeKey{
      tenant_id: "background",
      space_id: "background",
      episode_id: "background"
    }

    case Postgrex.query(
           Database.connection(episode),
           query,
           [limit],
           timeout: 2_000
         ) do
      {:ok, %{rows: rows}} ->
        {:ok,
         Enum.map(rows, fn row ->
           operation = ExternalOperationRecord.from_row(row)

           {%EpisodeKey{
              tenant_id: UUID.load!(Enum.at(row, 0)),
              space_id: UUID.load!(Enum.at(row, 1)),
              episode_id: UUID.load!(Enum.at(row, 2))
            }, operation}
         end)}

      {:error, _reason} ->
        {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def read_operation(%EpisodeKey{} = episode, external_operation_id)
      when is_binary(external_operation_id) do
    case UUID.dump(external_operation_id) do
      {:ok, id} -> read_operation_row(episode, id)
      :error -> :not_found
    end
  catch
    :exit, _reason -> {:retryable, :decision_unavailable}
  end

  defp read_operation_row(episode, id) do
    case Postgrex.query(
           Database.connection(episode, 1),
           SQL.read_operation(),
           Scope.episode(episode) ++ [id],
           timeout: 1_000
         ) do
      {:ok, %{rows: [row]}} -> {:ok, ExternalOperationRecord.from_row(row)}
      {:ok, %{rows: []}} -> :not_found
      {:error, _reason} -> {:retryable, :decision_unavailable}
    end
  end
end
