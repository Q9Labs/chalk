defmodule ChalkSync.Stateholder.Postgres.Attention do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.UUID

  def enabled?(%EpisodeKey{} = episode) do
    Database.guard(
      fn ->
        case Postgrex.query(
               Database.connection(episode),
               "select coalesce((config_snapshot -> 'attention' ->> 'enabled')::boolean, false) from episodes where tenant_id=$1 and space_id=$2 and id=$3",
               Scope.episode(episode),
               timeout: 1_000
             ) do
          {:ok, %{rows: [[enabled]]}} when is_boolean(enabled) -> {:ok, enabled}
          {:ok, %{rows: []}} -> {:error, :episode_not_found}
          _ -> {:retryable, :dependency_unavailable}
        end
      end,
      {:retryable, :dependency_unavailable}
    )
  end

  def close_interval(
        %EpisodeKey{} = episode,
        participant_id,
        state,
        windowed,
        started_at_ms,
        ended_at_ms
      )
      when state in ["active", "inactive", "background"] and is_boolean(windowed) and
             is_integer(started_at_ms) and is_integer(ended_at_ms) do
    if ended_at_ms <= started_at_ms do
      :ok
    else
      Database.guard(
        fn ->
          Postgrex.query!(
            Database.connection(episode),
            """
            insert into episode_attention_intervals (
              tenant_id, space_id, episode_id, participant_id, id, state, windowed, started_at, ended_at
            ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            """,
            Scope.episode(episode) ++
              [
                Scope.uuid(participant_id),
                UUID.dump!(UUID.generate()),
                state,
                windowed,
                DateTime.from_unix!(started_at_ms, :millisecond),
                DateTime.from_unix!(ended_at_ms, :millisecond)
              ],
            timeout: 1_000
          )

          :ok
        end,
        :ok
      )
    end
  rescue
    _exception -> :ok
  catch
    :exit, _reason -> :ok
  end
end
