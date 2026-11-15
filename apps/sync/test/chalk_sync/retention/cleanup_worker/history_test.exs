defmodule ChalkSync.Retention.CleanupWorkerHistoryTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @retention_seconds 7 * 24 * 60 * 60
  @first_deadline_ms 1_783_036_800_123

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

  test "holds an Episode whose independent fold detects corruption and cleans the rest", %{
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

    held_id = UUID.dump!(fixture.episode.episode_id)

    assert {:ok,
            %Result{episodes: 0, held: [{^held_id, {:invalid_history, :event_digest_mismatch}}]}} =
             run_cleanup(connection)

    assert [events, intents] = history_counts(connection, fixture)
    assert events > 0
    assert intents > 0
    refute checkpointed?(connection, fixture)

    assert {:ok, %Result{held: []}} = run_cleanup(connection, excluded_episode_ids: [held_id])
    refute checkpointed?(connection, fixture)
  end

  test "a held Episode does not block a healthy Episode in the same batch", %{
    connections: connections
  } do
    connection = hd(connections)
    corrupt = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, corrupt)
    healthy = seed_ended_episode(connection, @retention_seconds + 1)
    cleanup_fixture(connection, healthy)

    Postgrex.query!(
      connection,
      "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(corrupt)
    )

    corrupt_id = UUID.dump!(corrupt.episode.episode_id)

    assert {:ok, %Result{episodes: 1, held: [{^corrupt_id, _reason}]}} =
             run_cleanup(connection, batch_size: 16)

    assert checkpointed?(connection, healthy)
    refute checkpointed?(connection, corrupt)
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

    assert {:ok, %Result{episodes: 0, held: [{_id, {:invalid_history, :event_digest_mismatch}}]}} =
             run_cleanup(connection)

    assert [2, 1] = history_counts(connection, fixture)
    refute checkpointed?(connection, fixture)
  end

  test "holds an Episode with a deadline change instead of crashing the batch", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_ended_episode_with_deadline(connection, ~U[2026-07-03 00:00:00.123090Z])
    cleanup_fixture(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_control_events set event_name = 'deadline_changed' where tenant_id = $1 and episode_id = $2 and revision = 1",
      episode_ids(fixture)
    )

    assert {:ok, %Result{episodes: 0, held: [{_id, {:invalid_history, _reason}}]}} =
             run_cleanup(connection)

    refute checkpointed?(connection, fixture)
  end

  test "verifies an Episode whose deadline was extended, from the first deadline the control row recorded",
       %{connections: connections} do
    connection = hd(connections)
    fixture = seed_extended_episode(connection)

    assert [[@first_deadline_ms, 1]] = recorded_deadline(connection, fixture)
    assert {:ok, %Result{episodes: 1, event_rows: 3}} = run_cleanup(connection)
    assert checkpointed?(connection, fixture)
  end

  test "verifies an Episode extended before the first deadline was recorded", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = seed_extended_episode(connection)

    Postgrex.query!(
      connection,
      "update sync_episode_control set initial_deadline_at_ms = null, initial_deadline_generation = null where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    )

    assert {:ok, %Result{episodes: 1, event_rows: 3}} = run_cleanup(connection)
    assert checkpointed?(connection, fixture)
  end

  for {label, recorded?} <- [{"with", true}, {"without", false}] do
    test "still rejects a changed event in an extended Episode #{label} a recorded first deadline",
         %{
           connections: connections
         } do
      connection = hd(connections)
      fixture = seed_extended_episode(connection)

      unless unquote(recorded?) do
        Postgrex.query!(
          connection,
          "update sync_episode_control set initial_deadline_at_ms = null, initial_deadline_generation = null where tenant_id = $1 and episode_id = $2",
          episode_ids(fixture)
        )
      end

      Postgrex.query!(
        connection,
        "update sync_control_events set resulting_state_digest = decode(repeat('01', 32), 'hex') where tenant_id = $1 and episode_id = $2 and revision = 1",
        episode_ids(fixture)
      )

      assert {:ok,
              %Result{episodes: 0, held: [{_id, {:invalid_history, :event_digest_mismatch}}]}} =
               run_cleanup(connection)

      refute checkpointed?(connection, fixture)
    end
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

    # This fixture sets the deadline by hand, so what the trigger recorded does not describe it.
    Postgrex.query!(
      connection,
      "update sync_episode_control set initial_deadline_at_ms = null, initial_deadline_generation = null where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
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

  # The Episode starts with a deadline an hour after it was created and extends it once, so the join
  # event's digest covers a deadline that the extension then replaces.
  defp seed_extended_episode(connection) do
    created_at = ~U[2026-07-02 23:00:00.123456Z]
    first_deadline = ~U[2026-07-03 00:00:00.123Z]
    extended_deadline_ms = DateTime.to_unix(first_deadline, :millisecond) + 3_600_000
    first_deadline_ms = DateTime.to_unix(first_deadline, :millisecond)
    assert first_deadline_ms == @first_deadline_ms

    fixture = SyncPostgres.seed_episode(connection, 1, %{deadline_at_ms: first_deadline_ms})

    # The fixture predates its own history, so line the Episode row up with the state it starts from.
    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, "set local session_replication_role = replica", [])

      Postgrex.query!(
        transaction,
        "update episodes set created_at = $3, started_at = $3, deadline_at = $4 where tenant_id = $1 and id = $2",
        episode_ids(fixture) ++ [created_at, first_deadline]
      )
    end)

    {:ok, extension} =
      Operation.new("retention_deadline_extension", :tenant_set_deadline, %{
        "deadlineAtMs" => extended_deadline_ms,
        "deadlineGeneration" => 2
      })

    assert {:ok, %{external_operation_id: extension_id}} =
             Postgres.begin_internal_operation(fixture.episode, extension)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               extension_id,
               {:applied, :deadline_changed,
                %{"deadline_at_ms" => extended_deadline_ms, "deadline_generation" => 2}}
             )

    assert {:ok, %{external_operation_id: operation_id}} =
             Postgres.begin_operation(
               hd(fixture.identities),
               operation("retention_extended_episode_end", :end_episode, %{})
             )

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               operation_id,
               {:applied, :episode_ended, %{"reason" => "ended_by_participant"}}
             )

    synchronize_event_counters(connection, fixture)
    age_ended_episode(connection, fixture, @retention_seconds + 1)
    cleanup_fixture(connection, fixture)
    fixture
  end

  defp recorded_deadline(connection, fixture) do
    Postgrex.query!(
      connection,
      "select initial_deadline_at_ms, initial_deadline_generation from sync_episode_control where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    ).rows
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
