defmodule ChalkSync.LifecycleConsumerPostgresTest do
  use ExUnit.Case, async: false

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

    assert {:ok, []} = Postgres.pending_lifecycle_intents(32)
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

  defp restore_env(key, nil), do: Application.delete_env(:chalk_sync, key)
  defp restore_env(key, value), do: Application.put_env(:chalk_sync, key, value)

  defp stop_connection(connection) do
    if Process.alive?(connection), do: GenServer.stop(connection)
  end
end
