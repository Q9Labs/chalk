defmodule ChalkSync.Retention.CleanupWorkerExtendedDeadlineTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres

  @retention_seconds 7 * 24 * 60 * 60
  @first_deadline_ms 1_783_036_800_123

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

  test "holds, and does not abort the batch for, an Episode whose first deadline event has a malformed generation",
       %{connections: connections} do
    connection = hd(connections)
    fixture = seed_extended_episode(connection)

    Postgrex.query!(
      connection,
      "update sync_episode_control set initial_deadline_at_ms = null, initial_deadline_generation = null where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    )

    Postgrex.query!(
      connection,
      "update sync_control_events set payload = jsonb_set(payload, '{deadline_generation}', '\"corrupted\"') where tenant_id = $1 and episode_id = $2 and event_name = 'deadline_changed'",
      episode_ids(fixture)
    )

    assert {:ok, %Result{episodes: 0, held: [{_id, {:invalid_history, _reason}}]}} =
             run_cleanup(connection)

    refute checkpointed?(connection, fixture)
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
end
