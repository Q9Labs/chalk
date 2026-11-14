defmodule ChalkSync.LifecycleConsumerReadinessDueLagPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.LifecycleConsumerCase

  alias ChalkSync.ExternalOperationConsumer
  alias ChalkSync.Operations.Probe
  alias ChalkSync.Operations.Readiness
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  @tag :readiness_due_lag
  test "an unscheduled join stays pending without making readiness unready", %{
    connections: connections
  } do
    readiness = start_lifecycle_readiness()
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '1 day', next_attempt_at = 'infinity'::timestamptz
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    health = assert_lifecycle_ready(readiness)
    assert health.dependencies.database.oldest_pending_lifecycle_intent_ms == 0

    assert health.dependencies.database.lifecycle_intents == %{
             pending: 1,
             due: 0,
             retrying: 0,
             oldest_attempt_count: nil,
             oldest_error_code: nil
           }
  end

  @tag :readiness_due_lag
  test "an unscheduled join does not hide overdue lifecycle work", %{connections: connections} do
    readiness = start_lifecycle_readiness()
    connection = hd(connections)
    unscheduled = managed_pending_join(connection)
    overdue = managed_pending_join(connection)

    on_exit(fn ->
      SyncPostgres.cleanup(connection, unscheduled.episode)
      SyncPostgres.cleanup(connection, overdue.episode)
    end)

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '1 day', next_attempt_at = 'infinity'::timestamptz
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(unscheduled.lifecycle_intent_id)]
    )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '2 minutes',
          next_attempt_at = now() - interval '1 minute',
          attempt_count = 1, last_error_code = 'dependency_unavailable'
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(overdue.lifecycle_intent_id)]
    )

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        health = Readiness.probe_now(readiness)
        assert health.status == "unready"
        assert health.dependencies.reason == "lifecycle_intent_lag"
        assert health.dependencies.database.oldest_pending_lifecycle_intent_ms >= 120_000

        assert health.dependencies.database.lifecycle_intents == %{
                 pending: 2,
                 due: 1,
                 retrying: 1,
                 oldest_attempt_count: 1,
                 oldest_error_code: "dependency_unavailable"
               }
      end)

    assert log =~ "\"oldest_due_intent_id\":\"#{overdue.lifecycle_intent_id}\""
    refute log =~ unscheduled.lifecycle_intent_id
  end

  @tag :readiness_due_lag
  test "a seat held for 90 seconds stays ready through confirmation", %{connections: connections} do
    readiness = start_lifecycle_readiness()
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    schedule_join_expiry(connection, fixture, 30)

    health = assert_lifecycle_ready(readiness)
    assert health.dependencies.database.oldest_pending_lifecycle_intent_ms == 0
    assert health.dependencies.database.lifecycle_intents.pending == 1
    assert health.dependencies.database.lifecycle_intents.due == 0
    assert health.dependencies.database.lifecycle_intents.oldest_attempt_count == nil
    assert health.dependencies.database.lifecycle_intents.oldest_error_code == nil

    assert {:ok, %{result: :applied}} = Postgres.confirm_admission(fixture.identity)
    health = assert_lifecycle_ready(readiness)
    assert health.dependencies.database.lifecycle_intents.pending == 0
  end

  @tag :readiness_due_lag
  test "join expiry lag starts when due and recovers after expiry", %{connections: connections} do
    readiness = start_lifecycle_readiness()
    connection = hd(connections)
    fixture = managed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    schedule_join_expiry(connection, fixture, -10)

    health = assert_lifecycle_ready(readiness)
    assert health.dependencies.database.oldest_pending_lifecycle_intent_ms >= 10_000
    assert health.dependencies.database.oldest_pending_lifecycle_intent_ms < 30_000
    assert health.dependencies.database.lifecycle_intents.due == 1
    assert health.dependencies.database.lifecycle_intents.oldest_attempt_count == 0

    schedule_join_expiry(connection, fixture, -31)

    handler = "readiness-failure-#{System.unique_integer([:positive])}"

    :ok =
      :telemetry.attach(
        handler,
        [:chalk_sync, :observability, :event],
        fn _event, _measurements, metadata, owner ->
          send(owner, {:readiness_event, metadata})
        end,
        self()
      )

    on_exit(fn -> :telemetry.detach(handler) end)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        Readiness.probe_now(readiness)
        health = Readiness.probe_now(readiness)
        refute Readiness.ready?(readiness)
        assert health.status == "unready"
        assert health.dependencies.reason == "lifecycle_intent_lag"
        refute JSON.encode!(health) =~ fixture.lifecycle_intent_id
        refute JSON.encode!(health) =~ "oldest_due_intent"
      end)

    assert_receive {:readiness_event,
                    %{
                      event: "sync.readiness.failed",
                      attributes:
                        %{check: "database_validation", reason: "lifecycle_intent_lag"} =
                          attributes
                    }}

    assert attributes.oldest_pending_lifecycle_intent_ms >= 31_000
    assert attributes.lifecycle_lag_limit_ms == 30_000
    assert attributes.oldest_due_intent_id == fixture.lifecycle_intent_id
    assert attributes.oldest_due_intent_kind == "participant_joined"
    assert attributes.oldest_due_intent_attempts == 0
    assert {:ok, due_at, 0} = DateTime.from_iso8601(attributes.oldest_due_intent_due_at)
    assert DateTime.diff(DateTime.utc_now(), due_at) >= 31
    assert log =~ "\"event\":\"sync.readiness.failed\""
    assert log =~ fixture.lifecycle_intent_id
    assert log =~ attributes.oldest_due_intent_due_at
    refute log =~ fixture.identity.participant_id
    refute log =~ fixture.episode.episode_id
    refute log =~ "Pending Participant"

    assert {:ok, %{result: :superseded}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    health = assert_lifecycle_ready(readiness)
    assert health.dependencies.database.lifecycle_intents.pending == 0
    assert [["left", "expired", false]] = entry_row(connection, fixture)
  end

  defp schedule_join_expiry(connection, fixture, seconds_until_due) do
    Postgrex.query!(
      connection,
      "update participant_join_seats set expires_at = now() + $2::integer * interval '1 second' where participant_id = $1",
      [UUID.dump!(fixture.identity.participant_id), seconds_until_due]
    )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents intent
      set created_at = seat.expires_at - interval '120 seconds', next_attempt_at = seat.expires_at
      from participant_join_seats seat
      where intent.lifecycle_intent_id = $1 and seat.participant_id = intent.participant_id
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )
  end

  defp start_lifecycle_readiness do
    start_supervised!({ChalkSync.Fanout.PostgresNotifications, url: @database_url})
    start_supervised!({ChalkSync.LifecycleConsumer, poll_interval_ms: 60_000})
    ChalkSync.LifecycleConsumer.health()

    Enum.each(
      ExternalOperationConsumer.child_specs(poll_interval_ms: 60_000),
      &start_supervised!/1
    )

    start_supervised!({ChalkSync.Retention.Scheduler, auto_run?: false})

    # Boot probes check the real dependencies without requiring background poll freshness.
    start_supervised!(
      {Readiness,
       name: nil,
       auto_probe?: false,
       success_span_ms: 0,
       probe_fun: fn -> Probe.run(boot?: true) end}
    )
  end

  defp assert_lifecycle_ready(readiness) do
    Readiness.probe_now(readiness)
    Readiness.probe_now(readiness)
    health = Readiness.probe_now(readiness)
    assert health.status == "ready"
    assert Readiness.ready?(readiness)
    health
  end
end
