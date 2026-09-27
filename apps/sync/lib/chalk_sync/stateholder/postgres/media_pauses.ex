defmodule ChalkSync.Stateholder.Postgres.MediaPauses do
  @moduledoc false

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.MediaPauses, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  def set_transaction(connection, %Identity{} = identity, source, publication_id) do
    Transaction.configure(connection)

    authority = Scope.participant(identity) ++ [identity.participant_generation]

    case Postgrex.query!(connection, SQL.lock_authority(), authority).rows do
      [["active", "active"]] -> :ok
      [["active", _status]] -> Postgrex.rollback(connection, {:error, :participant_inactive})
      [[_status, _participant_status]] -> Postgrex.rollback(connection, {:error, :episode_ended})
      [] -> Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end

    if is_binary(publication_id) do
      Postgrex.query!(
        connection,
        SQL.upsert(),
        authority ++ [Atom.to_string(source), publication_id]
      )
    else
      Postgrex.query!(
        connection,
        SQL.clear(),
        Scope.participant(identity) ++ [Atom.to_string(source)]
      )
    end

    :ok
  end

  # At most 500 Participants and two pausable sources per Episode.
  def decode_rows(rows) when length(rows) <= 1000 do
    {:ok,
     Map.new(rows, fn [participant_id, source, publication_id] ->
       {{UUID.load!(participant_id), source}, publication_id}
     end)}
  end

  def decode_rows(_rows), do: {:retryable, :dependency_unavailable}
end
