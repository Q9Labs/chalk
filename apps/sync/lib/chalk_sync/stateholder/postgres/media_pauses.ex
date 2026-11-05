defmodule ChalkSync.Stateholder.Postgres.MediaPauses do
  @moduledoc false

  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.MediaPauses, as: SQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  def set_transaction(connection, %Identity{} = identity, source, publication_id) do
    authority = lock_authority(connection, identity)

    if is_binary(publication_id) do
      Postgrex.query!(
        connection,
        SQL.upsert(),
        authority ++ [Atom.to_string(source), publication_id]
      )
    else
      params = Scope.participant(identity) ++ [Atom.to_string(source)]
      Postgrex.query!(connection, SQL.clear(), params)
    end

    :ok
  end

  defp lock_authority(connection, identity) do
    Transaction.configure(connection)

    authority = Scope.participant(identity) ++ [identity.participant_generation]

    case Postgrex.query!(connection, SQL.lock_authority(), authority).rows do
      [["active", "active"]] -> authority
      [["active", _status]] -> Postgrex.rollback(connection, {:error, :participant_inactive})
      [[_status, _participant_status]] -> Postgrex.rollback(connection, {:error, :episode_ended})
      [] -> Postgrex.rollback(connection, {:error, :stale_participant_generation})
    end
  end

  # Runs inside the transaction that commits the stop event, so the stop and its revision are one fact.
  def record_stop(connection, episode, participant_id, source, revision) do
    Postgrex.query!(
      connection,
      SQL.upsert_stop(),
      Scope.episode(episode) ++ [Scope.uuid(participant_id), Atom.to_string(source), revision]
    )

    :ok
  end

  # At most 500 Participants and three sources per Episode.
  def decode_stop_rows(rows) when length(rows) <= 1500 do
    {:ok,
     Map.new(rows, fn [participant_id, source, revision] ->
       {{UUID.load!(participant_id), source}, revision}
     end)}
  end

  def decode_stop_rows(_rows), do: {:retryable, :dependency_unavailable}

  # At most 500 Participants and two pausable sources per Episode.
  def decode_rows(rows) when length(rows) <= 1000 do
    {:ok,
     Map.new(rows, fn [participant_id, source, publication_id] ->
       {{UUID.load!(participant_id), source}, publication_id}
     end)}
  end

  def decode_rows(_rows), do: {:retryable, :dependency_unavailable}
end
