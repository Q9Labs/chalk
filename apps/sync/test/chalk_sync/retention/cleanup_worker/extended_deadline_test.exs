defmodule ChalkSync.Retention.CleanupWorkerExtendedDeadlineTest do
  use ChalkSync.Retention.CleanupWorkerCase, async: false

  alias ChalkSync.Retention.CleanupWorker.Result
  alias ChalkSync.Stateholder.Operation
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.SyncPostgres.Rows

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

  # The two Episodes held in production. Offsets are milliseconds after creation, floored; the
  # first deadline is the Space's default of 3,600 seconds after creation and is in no event, so
  # nothing proves it was not a caller's deadline. Both Episodes: two joins, four deadline changes
  # (generation 2 near ten minutes, generation 3 near forty), then the end.
  @observed [
    a: %{
      created_at: ~U[2026-07-02 23:00:00.730661Z],
      deadlines: [601_463, 2_401_463, 303_085, 63_572]
    },
    b: %{
      created_at: ~U[2026-07-02 23:00:00.318667Z],
      deadlines: [603_011, 2_403_011, 304_727, 65_116]
    }
  ]
  @observed_default_seconds 3_600

  for {name, observed} <- @observed do
    test "recovers the first deadline of observed Episode #{name} from the default duration", %{
      connections: connections
    } do
      connection = hd(connections)
      fixture = seed_observed_episode(connection, unquote(Macro.escape(observed)), 0)

      assert {:ok, %Result{episodes: 1, event_rows: 7}} = run_cleanup(connection)
      assert checkpointed?(connection, fixture)
    end

    test "recovers observed Episode #{name} when the default is a whole second but not a whole minute",
         %{connections: connections} do
      connection = hd(connections)
      fixture = seed_observed_episode(connection, unquote(Macro.escape(observed)), 0, 3_601)

      assert {:ok, %Result{episodes: 1, event_rows: 7}} = run_cleanup(connection)
      assert checkpointed?(connection, fixture)
    end

    for {label, extra_ms} <- [
          {"is a fraction of a second off the default", 417},
          {"is half a minute off the default", 30_000}
        ] do
      test "holds observed Episode #{name} when its first deadline #{label}",
           %{connections: connections} do
        connection = hd(connections)

        fixture =
          seed_observed_episode(connection, unquote(Macro.escape(observed)), unquote(extra_ms))

        assert {:ok,
                %Result{episodes: 0, held: [{_id, {:invalid_history, :event_digest_mismatch}}]}} =
                 run_cleanup(connection)

        refute checkpointed?(connection, fixture)
      end
    end
  end

  defp seed_observed_episode(
         connection,
         observed,
         extra_ms,
         default_seconds \\ @observed_default_seconds
       ) do
    created_ms = DateTime.to_unix(observed.created_at, :millisecond)

    # A deadline is a whole millisecond and the offsets floor the fraction of created_at away.

    fixture =
      seed_extended_episode(connection, %{
        created_at: observed.created_at,
        participants: 2,
        default_seconds: default_seconds,
        first_deadline_ms: created_ms + default_seconds * 1_000 + extra_ms,
        deadlines: Enum.map(observed.deadlines, &(created_ms + &1 + 1))
      })

    Postgrex.query!(
      connection,
      "update sync_episode_control set initial_deadline_at_ms = null, initial_deadline_generation = null where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    )

    fixture
  end

  # The Episode starts with a deadline an hour after it was created and extends it once, so the join
  # event's digest covers a deadline that the extension then replaces. A spec changes that shape:
  # `:participants` joins more people, `:first_deadline_ms` and `:default_seconds` set the first
  # deadline and the default duration the Episode's configuration froze, and `:deadlines` lists every
  # later deadline (one `deadline_changed` event each, generation 2 onwards).
  defp seed_extended_episode(connection, spec \\ %{}) do
    created_at = Map.get(spec, :created_at, ~U[2026-07-02 23:00:00.123456Z])
    first_deadline_ms = Map.get(spec, :first_deadline_ms, @first_deadline_ms)
    first_deadline = DateTime.from_unix!(first_deadline_ms, :millisecond)
    deadlines = Map.get(spec, :deadlines, [first_deadline_ms + 3_600_000])

    fixture =
      SyncPostgres.seed_episode(connection, Map.get(spec, :participants, 1), %{
        deadline_at_ms: first_deadline_ms,
        default_episode_duration_seconds: Map.get(spec, :default_seconds, 86_400)
      })

    # The fixture predates its own history, so line the Episode row up with the state it starts from.
    Postgrex.transaction(connection, fn transaction ->
      Postgrex.query!(transaction, "set local session_replication_role = replica", [])

      Postgrex.query!(
        transaction,
        "update episodes set created_at = $3, started_at = $3, deadline_at = $4 where tenant_id = $1 and id = $2",
        episode_ids(fixture) ++ [created_at, first_deadline]
      )

      Postgrex.query!(
        transaction,
        "insert into episode_create_requests (tenant_id, space_id, request_key, request_fingerprint, episode_id, created_at) values ($1, $2, $3, decode(repeat('00', 32), 'hex'), $4, $5)",
        [
          Rows.uuid(fixture.episode.tenant_id),
          Rows.uuid(fixture.episode.space_id),
          "retention_extended_episode_request",
          Rows.uuid(fixture.episode.episode_id),
          created_at
        ]
      )
    end)

    for {deadline_ms, index} <- Enum.with_index(deadlines, 2) do
      change_deadline(fixture, deadline_ms, index)
    end

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

  defp change_deadline(fixture, deadline_ms, generation) do
    {:ok, change} =
      Operation.new("retention_deadline_change_#{generation}", :tenant_set_deadline, %{
        "deadlineAtMs" => deadline_ms,
        "deadlineGeneration" => generation
      })

    assert {:ok, %{external_operation_id: change_id}} =
             Postgres.begin_internal_operation(fixture.episode, change)

    assert {:ok, %{result: :applied}} =
             Postgres.finalize_operation(
               fixture.episode,
               change_id,
               {:applied, :deadline_changed,
                %{"deadline_at_ms" => deadline_ms, "deadline_generation" => generation}}
             )
  end

  defp recorded_deadline(connection, fixture) do
    Postgrex.query!(
      connection,
      "select initial_deadline_at_ms, initial_deadline_generation from sync_episode_control where tenant_id = $1 and episode_id = $2",
      episode_ids(fixture)
    ).rows
  end
end
