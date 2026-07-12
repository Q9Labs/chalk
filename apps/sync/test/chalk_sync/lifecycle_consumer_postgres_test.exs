defmodule ChalkSync.LifecycleConsumerPostgresTest do
  use ExUnit.Case, async: false

  alias ChalkSync.LifecycleConsumer
  alias ChalkSync.Stateholder.Postgres
  alias ChalkSync.SyncPostgres
  alias ChalkSync.UUID

  @database_url System.get_env("CHALK_SYNC_TEST_DATABASE_URL") ||
                  System.get_env("CHALK_DATABASE_URL")

  if is_nil(@database_url), do: @moduletag(skip: "set CHALK_SYNC_TEST_DATABASE_URL")

  setup_all do
    if @database_url do
      previous_stateholder = Application.fetch_env!(:chalk_sync, :stateholder)
      previous_connections = Application.get_env(:chalk_sync, :database_connections)
      connections = SyncPostgres.start_connections(@database_url)

      Application.put_env(:chalk_sync, :stateholder, Postgres)
      Application.put_env(:chalk_sync, :database_connections, SyncPostgres.selector(connections))

      on_exit(fn ->
        Application.put_env(:chalk_sync, :stateholder, previous_stateholder)
        restore_env(:database_connections, previous_connections)
        Enum.each(connections, &stop_connection/1)
      end)

      {:ok, connections: connections}
    else
      :ok
    end
  end

  test "moves retrying intents behind a newer processable intent", %{connections: connections} do
    connection = hd(connections)
    poison = Enum.map(1..33, fn _index -> SyncPostgres.seed_pending_join(connection) end)
    good = SyncPostgres.seed_pending_join(connection)

    on_exit(fn ->
      Enum.each([good | poison], &SyncPostgres.cleanup(connection, &1.session))
    end)

    Enum.each(poison, fn fixture ->
      make_intent_invalid(connection, fixture)
      age_intent(connection, fixture)
    end)

    consumer_name = Module.concat(__MODULE__, "Consumer#{System.unique_integer([:positive])}")

    start_supervised!(
      {LifecycleConsumer, name: consumer_name, poll_interval_ms: 10, page_size: 32},
      id: consumer_name
    )

    eventually(fn -> intent_status(connection, good) == "applied" end)

    Enum.each(poison, fn fixture ->
      assert ["pending", attempt_count, "invalid_lifecycle_transition"] =
               intent_attempt(connection, fixture)

      assert attempt_count >= 1
    end)

    health = LifecycleConsumer.health(consumer_name)
    assert health.applied_count >= 1
    assert health.consecutive_failures == 0
  end

  test "records concurrent failures without losing attempts or overflowing the counter", %{
    connections: connections
  } do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    first =
      Task.async(fn ->
        Process.put(:sync_test_node, :first)

        Postgres.record_lifecycle_failure(
          fixture.session,
          fixture.lifecycle_intent_id,
          :dependency_unavailable
        )
      end)

    second =
      Task.async(fn ->
        Process.put(:sync_test_node, :second)

        Postgres.record_lifecycle_failure(
          fixture.session,
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
               fixture.session,
               fixture.lifecycle_intent_id,
               :dependency_unavailable
             )

    assert ["pending", 2_147_483_647, "dependency_unavailable"] =
             intent_attempt(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.lifecycle_intent_id)

    assert ["applied", 2_147_483_647, nil] = intent_attempt(connection, fixture)
  end

  test "defers a full poison page until its durable retry deadline", %{connections: connections} do
    connection = hd(connections)
    poison = Enum.map(1..32, fn _index -> SyncPostgres.seed_pending_join(connection) end)

    on_exit(fn ->
      Enum.each(poison, &SyncPostgres.cleanup(connection, &1.session))
    end)

    Enum.each(poison, fn fixture ->
      Postgrex.query!(
        connection,
        "update sync_lifecycle_intents set attempt_count = 9 where lifecycle_intent_id = $1",
        [UUID.dump!(fixture.lifecycle_intent_id)]
      )

      assert :ok =
               Postgres.record_lifecycle_failure(
                 fixture.session,
                 fixture.lifecycle_intent_id,
                 :dependency_unavailable
               )
    end)

    assert {:ok, []} = Postgres.pending_lifecycle_intents(32)
  end

  test "saturates a poisoned intent before it is superseded", %{connections: connections} do
    connection = hd(connections)
    fixture = SyncPostgres.seed_pending_join(connection)
    on_exit(fn -> SyncPostgres.cleanup(connection, fixture.session) end)

    Postgrex.query!(
      connection,
      "update sync_lifecycle_intents set attempt_count = 2147483647 where lifecycle_intent_id = $1",
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )

    fixture = SyncPostgres.request_pending_end(connection, fixture)

    assert {:ok, %{result: :applied}} =
             Postgres.apply_lifecycle_intent(fixture.session, fixture.end_lifecycle_intent_id)

    assert ["superseded", 2_147_483_647, nil] = intent_attempt(connection, fixture)
  end

  defp make_intent_invalid(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update participants
      set status = 'active'
      where tenant_id = $1 and room_id = $2 and session_id = $3 and id = $4
      """,
      session_params(fixture) ++ [UUID.dump!(fixture.identity.participant_session_id)]
    )
  end

  defp age_intent(connection, fixture) do
    Postgrex.query!(
      connection,
      """
      update sync_lifecycle_intents
      set created_at = now() - interval '1 minute'
      where tenant_id = $1 and room_id = $2 and session_id = $3 and lifecycle_intent_id = $4
      """,
      session_params(fixture) ++ [UUID.dump!(fixture.lifecycle_intent_id)]
    )
  end

  defp intent_status(connection, fixture) do
    connection
    |> Postgrex.query!(
      "select status from sync_lifecycle_intents where lifecycle_intent_id = $1",
      [UUID.dump!(fixture.lifecycle_intent_id)]
    )
    |> Map.fetch!(:rows)
    |> then(fn [[status]] -> status end)
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

  defp session_params(fixture) do
    [
      UUID.dump!(fixture.session.tenant_id),
      UUID.dump!(fixture.session.room_id),
      UUID.dump!(fixture.session.session_id)
    ]
  end

  defp eventually(assertion, attempts \\ 100)

  defp eventually(assertion, attempts) when attempts > 0 do
    if assertion.() do
      :ok
    else
      Process.sleep(10)
      eventually(assertion, attempts - 1)
    end
  end

  defp eventually(_assertion, 0), do: flunk("condition did not become true")

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
