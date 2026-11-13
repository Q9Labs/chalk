defmodule ChalkSync.Stateholder.Postgres.Media do
  @moduledoc """
  Stateholder callbacks for Participant media state: authority, devices, pauses and publication grants.
  """

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.MediaPauses
  alias ChalkSync.Stateholder.Postgres.ParticipantAuthority
  alias ChalkSync.Stateholder.Postgres.ParticipantDevices
  alias ChalkSync.Stateholder.Postgres.PublicationGrants
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.MediaPauses, as: MediaPausesSQL
  alias ChalkSync.Stateholder.Postgres.Transaction
  alias ChalkSync.UUID

  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation)
      when is_binary(participant_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)),
      do: ParticipantAuthority.participant_authority(episode, participant_id, expected_generation)

  def participant_devices(%EpisodeKey{} = episode),
    do: ParticipantDevices.list(episode)

  def media_pauses(%EpisodeKey{} = episode) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection(episode),
               MediaPausesSQL.list(),
               Scope.episode(episode),
               timeout: 1_000
             ) do
          {:ok, %{rows: rows}} -> MediaPauses.decode_rows(rows)
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  def media_stops(%EpisodeKey{} = episode) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection(episode),
               MediaPausesSQL.list_stops(),
               Scope.episode(episode),
               timeout: 1_000
             ) do
          {:ok, %{rows: rows}} -> MediaPauses.decode_stop_rows(rows)
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  def set_media_pause(%Identity{} = identity, source, publication_id)
      when source in [:microphone, :camera, :screen] do
    Database.guard(
      fn ->
        case Transaction.run(
               identity.episode,
               &MediaPauses.set_transaction(&1, identity, source, publication_id),
               commit_comment: "chalk sync media pause"
             ) do
          {:ok, :ok} -> :ok
          {:error, {:error, reason}} -> {:error, reason}
          {:error, {:retryable, reason}} -> {:retryable, reason}
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  def reserve_publication_grant(%Identity{} = identity, operation_id, source)
      when is_binary(operation_id) and source in [:microphone, :camera, :screen] do
    Database.guard(
      fn ->
        case Transaction.run(
               identity.episode,
               &PublicationGrants.reserve_transaction(&1, identity, operation_id, source),
               commit_comment: "chalk sync publication grant reservation"
             ) do
          {:ok, reservation} -> {:ok, reservation}
          {:error, {:error, reason}} -> {:error, reason}
          {:error, {:retryable, reason}} -> {:retryable, reason}
          {:error, _reason} -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  def reserve_publication_grant(_identity, _operation_id, _source),
    do: {:error, :invalid_operation}

  def complete_publication_grant(%EpisodeKey{} = episode, reservation_id, outcome)
      when is_binary(reservation_id) do
    Database.guard(
      fn ->
        case UUID.dump(reservation_id) do
          {:ok, _id} -> complete_publication_grant(episode, reservation_id, outcome, :valid)
          :error -> {:error, :reservation_not_found}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  defp complete_publication_grant(episode, reservation_id, outcome, :valid) do
    case Transaction.run(
           episode,
           &PublicationGrants.complete_transaction(&1, episode, reservation_id, outcome),
           commit_comment: "chalk sync publication grant completion"
         ) do
      {:ok, result} -> {:ok, result}
      {:error, {:error, reason}} -> {:error, reason}
      {:error, {:retryable, reason}} -> {:retryable, reason}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  end
end
