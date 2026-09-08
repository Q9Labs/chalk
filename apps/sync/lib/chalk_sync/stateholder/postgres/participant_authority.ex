defmodule ChalkSync.Stateholder.Postgres.ParticipantAuthority do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.ParticipantAuthority, as: SQL
  alias ChalkSync.UUID

  def participant_authority(%EpisodeKey{} = episode, participant_id, expected_generation)
      when is_binary(participant_id) and
             (is_nil(expected_generation) or
                (is_integer(expected_generation) and expected_generation > 0)) do
    case UUID.dump(participant_id) do
      {:ok, participant_id} ->
        read_participant_authority(
          episode,
          participant_id,
          participant_id,
          expected_generation
        )

      :error ->
        {:error, :participant_inactive}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  defp read_participant_authority(episode, participant_id, participant_id, expected) do
    result =
      Postgrex.query(
        Database.connection(episode),
        SQL.participant_authority(),
        Scope.episode(episode) ++ [participant_id],
        timeout: 1_000
      )

    participant_authority_result(result, participant_id, expected)
  end

  defp participant_authority_result({:ok, %{rows: []}}, _participant_id, _expected),
    do: {:error, :episode_not_found}

  defp participant_authority_result(
         {:ok, %{rows: [[episode_status, _generation, _status, _role, _capabilities]]}},
         _participant_id,
         _expected
       )
       when episode_status != "active",
       do: {:error, :episode_ended}

  defp participant_authority_result(
         {:ok, %{rows: [["active", generation, _status, _role, _capabilities]]}},
         _participant_id,
         expected
       )
       when is_integer(expected) and generation != expected,
       do: {:error, :stale_participant_generation}

  defp participant_authority_result(
         {:ok, %{rows: [["active", generation, "active", role, capabilities]]}},
         participant_id,
         _expected
       ) do
    {:ok,
     %{
       participant_id: UUID.load!(participant_id),
       generation: generation,
       role: role,
       capabilities: capabilities
     }}
  end

  defp participant_authority_result({:ok, %{rows: [_row]}}, _participant_id, _expected),
    do: {:error, :participant_inactive}

  defp participant_authority_result({:error, _reason}, _participant_id, _expected),
    do: {:retryable, :dependency_unavailable}
end
