defmodule ChalkSync.LifecycleConsumerFailuresPostgresTest do
  use ChalkSync.ServerCase, async: false
  use ChalkSync.LifecycleConsumerCase

  alias ChalkSync.Operations.Probe
  alias ChalkSync.Operations.Readiness
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  test "records concurrent failures without losing attempts or overflowing the counter", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)

        Postgres.record_lifecycle_failure(
          fixture.episode,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    assert :ok = Task.await(first)
    assert :ok = Task.await(second)
    assert ["pending", 2, "dependency_unavailable"] = intent_attempt(connection, fixture)

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set attempt_count = 2147483647 where lifecycle_intent_id = $1",
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    assert :ok =
             Postgres.record_lifecycle_failure(
               fixture.episode,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    assert ["pending", 2_147_483_647, "dependency_unavailable"] =
             intent_attempt(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    assert ["applied", 2_147_483_647, nil] = intent_attempt(connection, fixture)
  end

  test "defers a full poison page until its durable retry deadline", %{connections: connections} do
    connection = hd(connections)
    poison = Enum.map(1..32, fn _index -> SyncPostgres.seed_pending_join(connection) end)

    on_exit(fn ->
      Enum.each(poison, &SyncPostgres.cleanup(connection, &1.episode))
    end)

    Enum.each(poison, fn fixture ->
      Postgrex.query!(
        connection,
        "update sync_lifecycle_intents set attempt_count = 9 where lifecycle_intent_id = $1",
        [UUID.dump!(fixture.lifecycle_intent_id)]
      )

      assert :ok =
               Postgres.record_lifecycle_failure(
                 fixture.episode,
                 fixture.lifecycle_intent_id,
                 :dependency_unavailable
               )
    end)

    assert {:ok, pending} = Postgres.pending_lifecycle_intents(32)

    for fixture <- poison do
      refute {fixture.episode, fixture.lifecycle_intent_id} in pending
    end
  end

  test "readiness retains bounded diagnostics for an aged retrying lifecycle intent", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.episode) end)

    assert :ok =
             Postgres.record_lifecycle_failure(
               fixture.episode,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '1 minute', next_attempt_at = now() + interval '1 minute'
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    readiness =
      start_supervised!({Readiness, name: nil, auto_probe?: false, probe_fun: &Probe.run/0})

    health = Readiness.probe_now(readiness)
    assert health.status == "unready"
    assert health.dependencies.reason == "lifecycle_intent_lag"
    database = health.dependencies.database
    assert database.oldest_pending_lifecycle_intent_ms >= 60_000
    assert database.lifecycle_intents.pending >= 1
    assert database.lifecycle_intents.retrying >= 1
    assert database.lifecycle_intents.due < database.lifecycle_intents.pending
    assert database.lifecycle_intents.oldest_attempt_count == 1
    assert database.lifecycle_intents.oldest_error_code == "dependency_unavailable"

    private_error = "private diagnostic must not escape"

    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents set last_error_code = $2 where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id), private_error]
    )

    redacted = Readiness.probe_now(readiness)
    assert redacted.dependencies.database.lifecycle_intents.oldest_error_code == "other"
    refute JSON.encode!(redacted) =~ private_error
    refute JSON.encode!(redacted) =~ fixture.lifecycle_intent_id
    refute JSON.encode!(redacted) =~ fixture.episode.episode_id

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.episode, fixture.lifecycle_intent_id)

    log =
      ExUnit.CaptureLog.capture_log(fn ->
        recovered = Readiness.probe_now(readiness)
        assert recovered.dependencies == %{reason: "required_process_unavailable"}
      end)

    assert log =~ "\"check\":\"Elixir.ChalkSync.Fanout.PostgresNotifications\""
    assert log =~ "\"observed\":false"
  end

  defp intent_attempt(connection, fixture) do
    connection
    |> Postgrex.query!(
      """
      select status, attempt_count, last_error_code
      from sync_lifecycle_intents
      where lifecycle_intent_id = $1
      """,
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )
    |> Map.fetch!(:rows)
    |> then(fn [attempt] -> attempt end)
  end
end
