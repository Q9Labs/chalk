defmodule ChalkSync.Retention.CleanupWorkerHistoryTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  @retention_seconds 7 * 24 * 60 * 60

  test "attendance survives verified Episode journal cleanup", %{connections: connections} do
    connection = hd(connections)
    fixture = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    attendance_sql =
      "select id, name, first_joined_at, left_at, last_left_reason from participants where tenant_id = $1 and episode_id = $2 order by first_joined_at, id"

    before = Postgrex.query!(connection, attendance_sql, episode_ids(fixture)).rows
    assert [[_id, "Pending Participant", %DateTime{}, %DateTime{}, "episode_ended"]] = before
    before_http = attendance_http_probe(fixture)

    assert {:ok, %Result{episodes: 1, event_rows: 2}} = run_cleanup(connection)
    assert [0, 0] = history_counts(connection, fixture)
    assert checkpointed?(connection, fixture)
    assert Postgrex.query!(connection, attendance_sql, episode_ids(fixture)).rows == before
    assert attendance_http_probe(fixture) == before_http
  end

  test "rolls back when the independent fold detects corruption", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [events, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)
  end

  test "verifies history using the millisecond deadline from a microsecond timestamp", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode_with_deadline(connection, ~U[2026-07-03 00:00:00.123090Z])
    cleanup_fixture(connection, fixture)

    assert {:ok, %Result{episodes: 1, event_rows: 2}} = run_cleanup(connection)
    assert checkpointed?(connection, fixture)
    assert [0, 0] = history_counts(connection, fixture)
  end

  test "still rejects a corrupt digest when the deadline has microsecond precision", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode_with_deadline(connection, ~U[2026-07-03 00:00:00.123090Z])
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(fixture)
    )

    assert {:error, {:invalid_history, :event_digest_mismatch}} = run_cleanup(connection)
    assert [2, 1] = history_counts(connection, fixture)
    refute checkpointed?(connection, fixture)
  end

  defp attendance_http_probe(fixture) do
    case System.get_env("CHALK_ATTENDANCE_HTTP_PROBE") do
      nil ->
        :not_configured

      executable ->
        {output, status} =
          System.cmd(executable, ["-test.run=^TestEpisodeAttendanceSyncFixtureHTTP$", "-test.v"],
            env: [
              {"CHALK_ATTENDANCE_TENANT_ID", fixture.episode.tenant_id},
              {"CHALK_ATTENDANCE_SPACE_ID", fixture.episode.space_id},
              {"CHALK_ATTENDANCE_EPISODE_ID", fixture.episode.episode_id}
            ],
            stderr_to_stdout: true
          )

        assert status == 0, output

        output
        |> String.split("\n")
        |> Enum.find(&String.starts_with?(&1, "ATTENDANCE_JSON="))
        |> tap(fn response -> assert is_binary(response) end)
    end
  end

  defp seed_ended_episode_with_deadline(connection, deadline) do
    fixture =
      SyncPostgres.seed_episode(connection, 1, %{
        deadline_at_ms: DateTime.to_unix(deadline, :millisecond),
        deadline_generation: 2
      })

    Postgrex.query!(
      connection,
      "update episodes set deadline_at = $3, deadline_generation = 2 where tenant_id = $1 and id = $2",
      episode_ids(fixture) ++ [deadline]
    )

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(
               hd(fixture.identities),
               operation("retention_deadline_episode_end", :end_episode, %{})
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    synchronize_event_counters(connection, fixture)
    age_ended_episode(connection, fixture, @retention_seconds + 1)
    fixture
  end

  defp history_counts(connection, fixture) do
    [[events, intents]] =
      Postgrex.query!(
        connection,
        """
        select
          (select count(*) from sync_control_events where tenant_id = $1 and episode_id = $2),
          (select count(*) from sync_lifecycle_intents where tenant_id = $1 and episode_id = $2)
        """,
        episode_ids(fixture)
      ).rows

    [events, intents]
  end
end
