defmodule ChalkSync.Stateholder.Postgres.RecoveryReader do
  @moduledoc false

  alias ChalkSync.Database
  alias ChalkSync.Episodes.Reducer
  alias ChalkSync.Stateholder.EpisodeKey
  alias ChalkSync.Stateholder.Identity
  alias ChalkSync.Stateholder.Postgres.Control
  alias ChalkSync.Stateholder.Postgres.Scope
  alias ChalkSync.Stateholder.Postgres.SQL.Recovery, as: SQL
  alias ChalkSync.Stateholder.Recovery

  @transaction_timeout_ms 3_000
  @max_replay_events 2_048
  @max_replay_bytes 2 * 1024 * 1024
  @schema_version 1

  def page(%EpisodeKey{} = episode, after_revision, through_revision) do
    params = [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      after_revision,
      through_revision
    ]

    case Postgrex.query(
           Database.connection(episode),
           SQL.read_recovery_page(),
           params,
           timeout: @transaction_timeout_ms
         ) do
      {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, &Control.event_from_row/1)}
      {:error, _reason} -> {:retryable, :dependency_unavailable}
    end
  rescue
    _exception -> {:retryable, :dependency_unavailable}
  catch
    :exit, _reason -> {:retryable, :dependency_unavailable}
  end

  def transaction(connection, %Identity{} = identity, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])

    with {:ok, control} <- read_control(connection, Scope.episode(identity.episode)),
         {:ok, status} <- read_episode_status(connection, Scope.episode(identity.episode)),
         {:ok, state} <- Control.validate_fold(identity.episode, control) do
      case validate_recovery_identity(connection, identity, status) do
        :ok ->
          build_recovery(
            connection,
            identity.episode,
            state,
            status,
            cursor,
            identity.protocol_version
          )

        {:terminal, reason} ->
          terminal_recovery(state, reason)

        {:error, reason} ->
          {:error, reason}
      end
    else
      {:error, reason} -> {:error, reason}
    end
  end

  def transaction(connection, %EpisodeKey{} = episode, cursor) do
    Postgrex.query!(connection, "set transaction isolation level repeatable read read only", [])
    params = Scope.episode(episode)

    with {:ok, control} <- read_control(connection, params),
         {:ok, status} <- read_episode_status(connection, params),
         {:ok, state} <- Control.validate_fold(episode, control) do
      build_recovery(connection, episode, state, status, cursor, 1)
    else
      {:error, reason} -> {:error, reason}
    end
  end

  defp validate_recovery_identity(_connection, _identity, status) when status != "active",
    do: {:terminal, :episode_ended}

  defp validate_recovery_identity(connection, identity, _status) do
    case Postgrex.query!(connection, SQL.read_participant_status(), Scope.participant(identity)).rows do
      [[generation, _status]] when generation != identity.participant_generation ->
        {:terminal, :stale_participant_generation}

      [[_generation, "active"]] ->
        validate_admission_intent(connection, identity)

      [[_generation, _status]] ->
        {:terminal, :participant_inactive}

      [] ->
        {:terminal, :participant_inactive}
    end
  end

  defp validate_admission_intent(_connection, %Identity{admission_lifecycle_intent_id: nil}),
    do: :ok

  defp validate_admission_intent(connection, identity) do
    params = Scope.participant(identity) ++ [Scope.uuid(identity.admission_lifecycle_intent_id)]

    case Postgrex.query!(connection, SQL.read_admission_intent(), params).rows do
      [["applied"]] -> :ok
      _ -> {:error, :invalid_admission_intent}
    end
  end

  defp read_control(connection, params) do
    case Postgrex.query!(connection, SQL.read_control(), params).rows do
      [[revision, folded_state, schema, digest, _space_id]] ->
        {:ok,
         %{
           revision: revision,
           folded_state: folded_state,
           state_schema_version: schema,
           digest: digest
         }}

      [] ->
        {:error, :episode_not_found}
    end
  end

  defp read_episode_status(connection, params) do
    case Postgrex.query!(connection, SQL.read_episode_status(), params).rows do
      [[status]] -> {:ok, status}
      [] -> {:error, :episode_not_found}
    end
  end

  defp build_recovery(_connection, _episode, state, status, nil, protocol_version),
    do: snapshot_recovery(state, status, protocol_version)

  defp build_recovery(connection, episode, state, status, cursor, protocol_version)
       when is_map(cursor) do
    head = recovery_head(state)

    cond do
      cursor_matches_head?(cursor, head) ->
        %Recovery{mode: recovery_mode(status, :up_to_date), head: head, snapshot: nil, events: []}

      valid_replay_cursor?(connection, episode, cursor, head) ->
        replay_recovery(
          connection,
          episode,
          state,
          status,
          cursor.revision,
          head.revision,
          protocol_version
        )

      true ->
        snapshot_recovery(state, status, protocol_version)
    end
  end

  defp build_recovery(_connection, _episode, state, status, _cursor, protocol_version),
    do: snapshot_recovery(state, status, protocol_version)

  defp valid_replay_cursor?(connection, episode, cursor, head) do
    valid_shape =
      is_integer(cursor.revision) and cursor.revision >= 0 and cursor.revision < head.revision and
        cursor.state_schema_version == @schema_version and is_binary(cursor.digest)

    valid_shape and cursor_digest(connection, episode, cursor.revision) == cursor.digest
  end

  defp cursor_digest(_connection, episode, 0),
    do: episode.episode_id |> Reducer.new() |> Reducer.digest()

  defp cursor_digest(connection, episode, revision) do
    params = [Scope.uuid(episode.tenant_id), Scope.uuid(episode.episode_id), revision]

    case Postgrex.query!(connection, SQL.read_cursor_digest(), params).rows do
      [[digest]] -> digest
      [] -> nil
    end
  end

  defp replay_recovery(
         connection,
         episode,
         state,
         status,
         revision,
         head_revision,
         protocol_version
       ) do
    params = [
      Scope.uuid(episode.tenant_id),
      Scope.uuid(episode.episode_id),
      revision,
      head_revision
    ]

    [[event_count, encoded_bytes]] =
      Postgrex.query!(connection, SQL.replay_summary(), params).rows

    if event_count <= @max_replay_events and encoded_bytes <= @max_replay_bytes do
      %Recovery{
        mode: recovery_mode(status, :replay),
        head: recovery_head(state),
        snapshot: nil,
        events: [],
        replay_cursor: revision
      }
    else
      snapshot_recovery(state, status, protocol_version)
    end
  end

  defp snapshot_recovery(state, status, protocol_version) do
    %Recovery{
      mode: recovery_mode(status, :snapshot),
      head: recovery_head(state),
      snapshot: Reducer.snapshot(state, protocol_version),
      events: [],
      terminal_reason: if(status == "ended", do: :episode_ended)
    }
  end

  defp terminal_recovery(state, reason) do
    %Recovery{
      mode: :terminal,
      head: recovery_head(state),
      snapshot: nil,
      events: [],
      terminal_reason: reason
    }
  end

  defp recovery_mode("ended", _active_mode), do: :terminal
  defp recovery_mode(_status, active_mode), do: active_mode

  defp recovery_head(state) do
    %{
      revision: state.revision,
      state_schema_version: Reducer.state_schema_version(),
      digest: Reducer.digest(state)
    }
  end

  defp cursor_matches_head?(cursor, head) do
    cursor.revision == head.revision and
      cursor.state_schema_version == head.state_schema_version and cursor.digest == head.digest
  end
end
